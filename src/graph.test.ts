import type { Node } from 'ngraph.graph'
import ngraphCreateGraph from 'ngraph.graph'
import ngraphPath from 'ngraph.path'
import { Graferse } from './graph.js'
import type { Lock, LinkLock, NextNode } from './graph.js'

const getLockForLink = (from: Node, to: Node) => {
    const link = Array.from(from.links || []).find(link => link.toId == to.id)
    return link?.data
}

describe('Graferse class', () => {
    test('creating locks', () => {
        const creator = new Graferse<Node>(node => node.id as string)
        expect(creator.locks).toEqual([])
        expect(creator.linkLocks).toEqual([])

        const lock1 = creator.makeLock('lock1')
        expect(typeof lock1).toBe("object")
        expect(creator.locks).toEqual([lock1])
        expect(creator.linkLocks).toEqual([])

        const linkLock1 = creator.makeLinkLock('a', 'b')
        expect(typeof linkLock1).toBe("object")
        expect(creator.locks).toEqual([lock1])
        expect(creator.linkLocks).toEqual([linkLock1])
    })
    test('lock groups', () => {
        const creator = new Graferse<Node>(node => node.id as string)
        const lock1 = creator.makeLock('lock1')
        const lock2 = creator.makeLock('lock2')
        creator.setLockGroup([lock1, lock2])

        expect(lock1.requestLock("agent1", "lock1")).toBeTruthy()

        // agent1 can take lock2 because its the same agent that took lock1
        expect(creator.isLockGroupAvailable(lock2, "agent1")).toBeTruthy()

        // but agent2 cannot because they belong to the same lock group
        expect(creator.isLockGroupAvailable(lock2, "agent2")).toBeFalsy()

        // when agent1 releases the lock, agent2 is returned for notification
        expect(lock1.unlock("agent1")).toEqual(new Set(["agent2"]))
    })
    test('clearAllLocks', () => {
        const creator = new Graferse<Node>(node => node.id as string)
        const lock1 = creator.makeLock('lock1')
        const lock2 = creator.makeLock('lock2')
        const linkLock1 = creator.makeLinkLock('up', 'down', true)
        const linkLock2 = creator.makeLinkLock('up', 'down', true)

        expect(lock1.requestLock("agent1", "lock1")).toBeTruthy()
        expect(lock2.requestLock("agent2", "lock2")).toBeTruthy()

        expect(linkLock1.requestLock("agent1", "up")).toBeTruthy()
        expect(linkLock2.requestLock("agent2", "up")).toBeTruthy()

        expect(lock1.isLocked()).toBeTruthy()
        expect(lock2.isLocked()).toBeTruthy()
        expect(linkLock1.isLocked()).toBeTruthy()
        expect(linkLock2.isLocked()).toBeTruthy()

        // agent2 tries to obtain a taken lock
        expect(lock1.requestLock("agent2", "lock1")).toBeFalsy()

        // clearing throws, because lock1 was requested directly above
        // and no call to lockNext exists to call again
        expect(() => creator.clearAllLocks("agent1")).toThrow()

        // but now agent2 can obtain the lock
        expect(lock1.requestLock("agent2", "lock1")).toBeTruthy()
    })
})

describe('no dependencies', () => {
    test('basic locking with identities', () => {
        const getLockForLink = (from: Lock, to: Lock) => {
            return creator.makeLinkLock(from.id, to.id)
        }
        const creator = new Graferse<Lock>(
            lock => lockToString.get(lock) as string// what we are going to give current nodes in
        )
        const nodeA = creator.makeLock('nodeA')
        const nodeB = creator.makeLock('nodeB')
        const nodeC = creator.makeLock('nodeC')
        const path1 = [nodeA, nodeB, nodeC]

        const nodeX = creator.makeLock('nodeX')
        const nodeY = creator.makeLock('nodeY')
        const path2 = [nodeX, nodeB, nodeY]

        const lockToString = new Map<Lock,string>()
        lockToString.set(nodeA, 'nodeA')
        lockToString.set(nodeB, 'nodeB')
        lockToString.set(nodeC, 'nodeC')
        lockToString.set(nodeX, 'nodeX')
        lockToString.set(nodeY, 'nodeY')

        const makeLocker = creator.makeMakeLocker(
            node => node,
            getLockForLink,
        )

        const forwardPaths1: Array<Array<NextNode>> = []
        const forwardPaths2: Array<Array<NextNode>> = []

        const test1At = makeLocker("test1").makePathLocker(path1)(
            (nextNodes) => { forwardPaths1.push(nextNodes) }
        )

        const test2At = makeLocker("test2").makePathLocker(path2)(
            (nextNodes) => { forwardPaths2.push(nextNodes) }
        )

        expect(forwardPaths1).toEqual([])
        expect(forwardPaths2).toEqual([])

        test1At.arrivedAt(path1.indexOf(nodeA))
        expect(forwardPaths1.map(path => path.map(nn => nn.node))).toEqual([['nodeA', 'nodeB']])
        expect(forwardPaths2.map(path => path.map(nn => nn.node))).toEqual([])

        test2At.arrivedAt(path2.indexOf(nodeX))
        expect(forwardPaths1.at(-1)).toEqual([{index: 0, node: 'nodeA'}, {index: 1, node: 'nodeB'}])
        expect(forwardPaths2.at(-1)).toEqual([{index: 0, node: 'nodeX'}]) // only nodeX because nodeB is locked

        test1At.arrivedAt(path1.indexOf(nodeB))
        expect(forwardPaths1.at(-1)).toEqual([{index: 1, node: 'nodeB'}, {index: 2, node: 'nodeC'}])
        expect(forwardPaths2.at(-1)).toEqual([{index: 0, node: 'nodeX'}]) // only nodeX because nodeB is still locked

        test1At.arrivedAt(path1.indexOf(nodeC))
        expect(forwardPaths1.at(-1)).toEqual([{index: 2, node: 'nodeC'}])
        expect(forwardPaths2.at(-1)).toEqual([{index: 0, node: 'nodeX'}, {index: 1, node: 'nodeB'}]) // nodeB is now unlocked

        test1At.clearAllPathLocks()
        //expect(forwardPath1).toEqual([])
        expect(nodeA.isLocked()).toBeFalsy()
        expect(nodeB.isLocked()).toBeTruthy()
        expect(nodeC.isLocked()).toBeFalsy()

        //expect(forwardPaths2).toEqual(['nodeB', 'nodeX']) // no change
        expect(nodeX.isLocked()).toBeTruthy()
        expect(nodeB.isLocked()).toBeTruthy()
        expect(nodeY.isLocked()).toBeFalsy()

        test2At.clearAllPathLocks()
        //expect(forwardPath1).toEqual([])
        expect(nodeA.isLocked()).toBeFalsy()
        expect(nodeB.isLocked()).toBeFalsy()
        expect(nodeC.isLocked()).toBeFalsy()

        //expect(forwardPaths2).toEqual([]) // no change
        expect(nodeX.isLocked()).toBeFalsy()
        expect(nodeB.isLocked()).toBeFalsy()
        expect(nodeY.isLocked()).toBeFalsy()
    })

    test('basic locking', () => {
        const getLockForLink = (from: Lock, to: Lock) => {
            return creator.makeLinkLock(from.id, to.id)
        }
        const creator = new Graferse<Lock>(node => node.id)
        const nodeA = creator.makeLock('nodeA')
        const nodeB = creator.makeLock('nodeB')
        const nodeC = creator.makeLock('nodeC')
        const path1 = [nodeA, nodeB, nodeC]

        const nodeX = creator.makeLock('nodeX')
        const nodeY = creator.makeLock('nodeY')
        const path2 = [nodeX, nodeB, nodeY]


        const makeLocker = creator.makeMakeLocker(node => node, getLockForLink)

        let forwardPath1: Array<NextNode> = []
        let forwardPath2: Array<NextNode> = []

        const test1At = makeLocker("test1").makePathLocker(path1)(
            (nextNodes) => { forwardPath1 = nextNodes }
        )

        const test2At = makeLocker("test2").makePathLocker(path2)(
            (nextNodes) => { forwardPath2 = nextNodes }
        )

        expect(forwardPath1).toEqual([])
        expect(forwardPath2).toEqual([])

        test1At.arrivedAt(path1.indexOf(nodeA))
        expect(forwardPath1).toEqual([{index: 0, node: 'nodeA'}, {index: 1, node: 'nodeB'}])
        expect(forwardPath2).toEqual([])

        test2At.arrivedAt(path2.indexOf(nodeX))
        expect(forwardPath1).toEqual([{index: 0, node: 'nodeA'}, {index: 1, node: 'nodeB'}])
        expect(forwardPath2).toEqual([{index: 0, node: 'nodeX'}]) // only nodeX because nodeB is locked

        test1At.arrivedAt(path1.indexOf(nodeB))
        expect(forwardPath1).toEqual([{index: 1, node: 'nodeB'}, {index: 2, node: 'nodeC'}])
        expect(forwardPath2).toEqual([{index: 0, node: 'nodeX'}]) // only nodeX because nodeB is still locked

        test1At.arrivedAt(path1.indexOf(nodeC))
        expect(forwardPath1).toEqual([{index: 2, node: 'nodeC'}])
        expect(forwardPath2).toEqual([{index: 0, node: 'nodeX'}, {index: 1, node: 'nodeB'}]) // nodeB is now unlocked

        test1At.clearAllPathLocks()
        //expect(forwardPath1).toEqual([])
        expect(nodeA.isLocked()).toBeFalsy()
        expect(nodeB.isLocked()).toBeTruthy()
        expect(nodeC.isLocked()).toBeFalsy()

        //expect(forwardPath2).toEqual([nodeB, nodeX]) // no change
        expect(nodeX.isLocked()).toBeTruthy()
        expect(nodeB.isLocked()).toBeTruthy()
        expect(nodeY.isLocked()).toBeFalsy()

        test2At.clearAllPathLocks()
        //expect(forwardPath1).toEqual([])
        expect(nodeA.isLocked()).toBeFalsy()
        expect(nodeB.isLocked()).toBeFalsy()
        expect(nodeC.isLocked()).toBeFalsy()

        //expect(forwardPath2).toEqual([]) // no change
        expect(nodeX.isLocked()).toBeFalsy()
        expect(nodeB.isLocked()).toBeFalsy()
        expect(nodeY.isLocked()).toBeFalsy()
    })
})

describe('ngraph', () => {
    test('basic locking', () => {
        const graph = ngraphCreateGraph()
        const creator = new Graferse<Node<Lock>>(node => node.id as string)

        const makeNode = (id: string) => graph.addNode(id, creator.makeLock(id))
        const nodeA = makeNode('a')
        const nodeB = makeNode('b')
        const nodeC = makeNode('c')

        graph.addLink('a', 'b', creator.makeLock('ab'))
        graph.addLink('b', 'c', creator.makeLock('bc'))

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const path = pathFinder.find('a', 'c').reverse()

        var forwardPath: Array<NextNode> = []
        const makeLocker = creator.makeMakeLocker(
            node => node.data,
            getLockForLink)("agent1").makePathLocker
        const locker = makeLocker(path)((nextNodes) => { forwardPath = nextNodes })
        const arrivedAt = (nodeId: string) =>
           locker.arrivedAt(path.findIndex(node => node.id === nodeId))

        // all nodes are unlocked
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeFalsy()
        expect(forwardPath).toEqual([])

        // progressing to the first node locks it, and the next
        arrivedAt('a')
        expect(nodeA.data.isLocked()).toBeTruthy()
        expect(nodeB.data.isLocked()).toBeTruthy()
        expect(nodeC.data.isLocked()).toBeFalsy()
        expect(forwardPath).toEqual([{index: 0, node: 'a'}, {index: 1, node: 'b'}])

        // progressing to the second node locks it, and the next
        // and unlocks nodes behind it
        arrivedAt('b')
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeTruthy()
        expect(nodeC.data.isLocked()).toBeTruthy()
        expect(forwardPath).toEqual([{index: 1, node: 'b'}, {index: 2, node: 'c'}])

        // progressing to the last node locks it
        // and unlocks nodes behind it
        arrivedAt('c')
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeTruthy()
        expect(forwardPath).toEqual([{index: 2, node: 'c'}])

    })

    test('basic locking - clearAllPathLocks', () => {
        const graph = ngraphCreateGraph()
        const creator = new Graferse<Node<Lock>>(node => node.id as string)

        const makeNode = (id: string) => graph.addNode(id, creator.makeLock(id))
        const nodeA = makeNode('a')
        const nodeB = makeNode('b')
        const nodeC = makeNode('c')

        graph.addLink('a', 'b', creator.makeLock('ab'))
        graph.addLink('b', 'c', creator.makeLock('bc'))

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const path = pathFinder.find('a', 'c').reverse()

        const makeLocker = creator.makeMakeLocker(node => node.data, getLockForLink)("agent1").makePathLocker
        var forwardPath: Array<NextNode> = []
        const locker = makeLocker(path)((nextNodes) => { forwardPath = nextNodes })
        const arrivedAt = (nodeId: string) =>
           locker.arrivedAt(path.findIndex(node => node.id === nodeId))

        // all nodes are unlocked
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeFalsy()
        expect(forwardPath).toEqual([])

        // progressing to the first node locks it, and the next
        arrivedAt('a')
        expect(nodeA.data.isLocked()).toBeTruthy()
        expect(nodeB.data.isLocked()).toBeTruthy()
        expect(nodeC.data.isLocked()).toBeFalsy()
        expect(forwardPath).toEqual([{index: 0, node: 'a'}, {index: 1, node: 'b'}])

        // progressing to the second node locks it, and the next
        // and unlocks nodes behind it
        arrivedAt('b')
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeTruthy()
        expect(nodeC.data.isLocked()).toBeTruthy()
        expect(forwardPath).toEqual([{index: 1, node: 'b'}, {index: 2, node: 'c'}])

        locker.clearAllPathLocks();

        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeFalsy()
    })

    test('unexpected queue jumping', () => {
        const graph = ngraphCreateGraph()
        const creator = new Graferse<Node<Lock>>(node => node.id as string)

        const makeNode = (id: string) => graph.addNode(id, creator.makeLock(id))
        const nodeA = makeNode('a')
        const nodeB = makeNode('b')
        const nodeC = makeNode('c')

        graph.addLink('a', 'b', creator.makeLock('ab'))
        graph.addLink('b', 'c', creator.makeLock('bc'))

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const path = pathFinder.find('a', 'c').reverse()

        var forwardPath: Array<NextNode> = []
        const makeLocker = creator.makeMakeLocker(node => node.data, getLockForLink)("agent1").makePathLocker
        const locker = makeLocker(path)((nextNodes) => { forwardPath = nextNodes })
        const arrivedAt = (nodeId: string) =>
           locker.arrivedAt(path.findIndex(node => node.id === nodeId))

        // manually lock all nodes
        nodeA.data.requestLock("agent1")
        nodeB.data.requestLock("agent1")
        nodeC.data.requestLock("agent1")

        expect(nodeA.data.isLocked()).toBeTruthy()
        expect(nodeB.data.isLocked()).toBeTruthy()
        expect(nodeC.data.isLocked()).toBeTruthy()

        expect(forwardPath).toEqual([])
        // suddenly appearing at the last node locks it
        // and unlocks nodes behind it
        arrivedAt('c')
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeTruthy()
        expect(forwardPath).toEqual([{index: 2, node: 'c'}])
    })

    test('two robot mutual exclusion', () => {
        const graph = ngraphCreateGraph()
        const creator = new Graferse<Node<Lock>>(node => node.id as string)

        const makeNode = (id: string) => graph.addNode(id, creator.makeLock(id))
        const nodeA = makeNode('a')
        const nodeB = makeNode('b')
        const nodeC = makeNode('c')
        const nodeD = makeNode('d')

        // A
        //  \
        //   v
        //   C ----> D
        //   ^
        //  /
        // B
        graph.addLink('a', 'c', creator.makeLock('ac'))
        graph.addLink('b', 'c', creator.makeLock('bc'))
        graph.addLink('c', 'd', creator.makeLock('cd'))

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const s1Path = pathFinder.find('a', 'd').reverse()
        const s2Path = pathFinder.find('b', 'c').reverse()

        var s1ForwardPath: Array<NextNode> = []
        var s2ForwardPath: Array<NextNode> = []
        const makeLocker = creator.makeMakeLocker(node => node.data, getLockForLink)
        const s1LockNext = makeLocker("agent1").makePathLocker(s1Path)((nextNodes) => { s1ForwardPath = nextNodes })
        const s2LockNext = makeLocker("agent2").makePathLocker(s2Path)((nextNodes) => { s2ForwardPath = nextNodes })

        // all nodes are unlocked
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeFalsy()
        expect(nodeD.data.isLocked()).toBeFalsy()
        expect(s1ForwardPath).toEqual([])
        expect(s2ForwardPath).toEqual([])

        // moving agent1 to the first node locks it, and the next
        s1LockNext.arrivedAt(s1Path.indexOf(nodeA))
        expect(nodeA.data.isLocked("agent1")).toBeTruthy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked("agent1")).toBeTruthy()
        expect(nodeD.data.isLocked()).toBeFalsy()
        expect(s1ForwardPath).toEqual([{index: 0, node: 'a'}, {index: 1, node: 'c'}])
        expect(s2ForwardPath).toEqual([])

        // moving agent1 to its first node locks it
        // but the second is common to both paths, and already locked
        s2LockNext.arrivedAt(s2Path.indexOf(nodeB))
        expect(nodeA.data.isLocked("agent1")).toBeTruthy()
        expect(nodeB.data.isLocked("agent2")).toBeTruthy()
        expect(nodeC.data.isLocked("agent1")).toBeTruthy()
        expect(nodeD.data.isLocked()).toBeFalsy()
        expect(s1ForwardPath).toEqual([{index: 0, node: 'a'}, {index: 1, node: 'c'}])
        expect(s2ForwardPath).toEqual([{index: 0, node: 'b'}])  // nodeC missing because locked by agent1

        // moving agent1 to the last node locks it, and unlocks all prior nodes
        // and allows agent2 to progress to NodeC
        s1LockNext.arrivedAt(s1Path.indexOf(nodeD))
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked("agent2")).toBeTruthy()
        expect(nodeC.data.isLocked("agent2")).toBeTruthy()
        expect(nodeD.data.isLocked("agent1")).toBeTruthy()
        expect(s1ForwardPath).toEqual([{index: 2, node: 'd'}])
        expect(s2ForwardPath).toEqual([{index: 0, node: 'b'}, {index: 1, node: 'c'}])
    })

    test('swap places via corridor', () => {
        // B                               G
        //  ^                             /
        //   \                           v
        //    C <----> D <----> E <----> F
        //   ^                            \
        //  /                              v
        // A                               H
    })

    test('bidirectional corridor convoy', () => {
        const graph = ngraphCreateGraph<Lock, LinkLock>()
        const creator = new Graferse<Node<Lock>>(x => x.id as string)

        const makeNode = (id: string) => graph.addNode(id, creator.makeLock(id))
        const nodeA = makeNode('a')
        const nodeB = makeNode('b')
        const nodeC = makeNode('c')
        const nodeD = makeNode('d')
        const nodeE = makeNode('e')
        const nodeF = makeNode('f')
        const nodeG = makeNode('g')
        const nodeH = makeNode('h')
        const nodeI = makeNode('i')

        // B                                        H
        //  \                                       ^
        //   v                                     /
        //    C <----> D <----> E <----> F <----> G
        //   ^                                     \
        //  /                                       v
        // A                                        I

        // bidirectional locks
        const lockCD = creator.makeLinkLock('c', 'd', true)
        const lockDE = creator.makeLinkLock('d', 'e', true)
        const lockEF = creator.makeLinkLock('e', 'f', true)
        const lockFG = creator.makeLinkLock('f', 'g', true)

        // bidirectional links
        const linkCD = graph.addLink('c', 'd', lockCD)
        const linkDC = graph.addLink('d', 'c', lockCD)

        const linkDE = graph.addLink('d', 'e', lockDE)
        const linkED = graph.addLink('e', 'd', lockDE)

        const linkEF = graph.addLink('e', 'f', lockEF)
        const linkFE = graph.addLink('f', 'e', lockEF)

        const linkFG = graph.addLink('f', 'g', lockFG)
        const linkGF = graph.addLink('g', 'f', lockFG)


        // directed links
        const linkAC = graph.addLink('a', 'c', creator.makeLinkLock('a', 'c'))
        const linkBC = graph.addLink('b', 'c', creator.makeLinkLock('b', 'c'))
        const linkGH = graph.addLink('g', 'h', creator.makeLinkLock('g', 'h'))
        const linkGI = graph.addLink('g', 'i', creator.makeLinkLock('g', 'i'))

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const s1Path = pathFinder.find('a', 'h').reverse()
        const s2Path = pathFinder.find('b', 'i').reverse()

        const makeLocker = creator.makeMakeLocker(
            node => node.data,
            getLockForLink,
        )
        const s1NextPaths: Array<Array<NextNode>> = []
        const s2NextPaths: Array<Array<NextNode>> = []
        var s1calls = 0
        var s2calls = 0
        const s1LockNext = makeLocker("agent1").makePathLocker(s1Path)((nextNodes) => {
            s1NextPaths.push(nextNodes)
            s1calls++
        })
        const s2LockNext = makeLocker("agent2").makePathLocker(s2Path)((nextNodes) => {
            s2NextPaths.push(nextNodes)
            s2calls++
        })

        // all nodes are unlocked
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeFalsy()
        expect(nodeD.data.isLocked()).toBeFalsy()
        expect(nodeE.data.isLocked()).toBeFalsy()
        expect(nodeF.data.isLocked()).toBeFalsy()
        expect(nodeG.data.isLocked()).toBeFalsy()
        expect(nodeH.data.isLocked()).toBeFalsy()
        expect(nodeI.data.isLocked()).toBeFalsy()

        // all links are unlocked
        // bidirectional links
        expect(linkCD.data).toBe(linkDC.data)
        expect(linkDE.data).toBe(linkED.data)
        expect(linkEF.data).toBe(linkFE.data)
        expect(linkFG.data).toBe(linkGF.data)

        expect(linkCD.data.isLocked()).toBeFalsy()
        expect(linkDE.data.isLocked()).toBeFalsy()
        expect(linkEF.data.isLocked()).toBeFalsy()
        expect(linkFG.data.isLocked()).toBeFalsy()

        // directed links
        expect(linkAC.data.isLocked()).toBeFalsy()
        expect(linkBC.data.isLocked()).toBeFalsy()
        expect(linkGH.data.isLocked()).toBeFalsy()
        expect(linkGI.data.isLocked()).toBeFalsy()

        // and we have no forward paths yet
        expect(s1NextPaths).toEqual([])
        expect(s2NextPaths).toEqual([])

        s1LockNext.arrivedAt(s1Path.indexOf(nodeA))
        // its current and next nodes are locked
        expect(nodeA.data.isLocked()).toBeTruthy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeTruthy()
        expect(nodeD.data.isLocked()).toBeFalsy()
        expect(nodeE.data.isLocked()).toBeFalsy()
        expect(nodeF.data.isLocked()).toBeFalsy()
        expect(nodeG.data.isLocked()).toBeFalsy()
        expect(nodeH.data.isLocked()).toBeFalsy()
        expect(nodeI.data.isLocked()).toBeFalsy()

        // all bidirectional links are locked until path ends
        // expect(linkAC.data.isLocked()).toBeFalsy() // not bidirectional, we dont care
        expect(linkCD.data.isLocked()).toBeTruthy()
        expect(linkDE.data.isLocked()).toBeTruthy()
        expect(linkEF.data.isLocked()).toBeTruthy()
        expect(linkFG.data.isLocked()).toBeTruthy()
        // expect(linkGH.data.isLocked()).toBeFalsy() // not bidrections, we dont care

        expect(s1NextPaths).toEqual([[{index: 0, node: 'a'}, {index: 1, node: 'c'}]])
        expect(s1calls).toEqual(1)

        // a following robot appears
        s2LockNext.arrivedAt(s2Path.indexOf(nodeB))

        // its current node is locked, but next fails because its locked by s1
        expect(nodeA.data.isLocked()).toBeTruthy()
        expect(nodeB.data.isLocked()).toBeTruthy()
        expect(nodeC.data.isLocked("agent1")).toBeTruthy()
        expect(nodeC.data.isLocked("agent2")).toBeFalsy()
        expect(nodeD.data.isLocked()).toBeFalsy()
        expect(nodeE.data.isLocked()).toBeFalsy()
        expect(nodeF.data.isLocked()).toBeFalsy()
        expect(nodeG.data.isLocked()).toBeFalsy()
        expect(nodeH.data.isLocked()).toBeFalsy()
        expect(nodeI.data.isLocked()).toBeFalsy()

        expect(s2NextPaths).toEqual([[{index: 0, node: 'b'}]])
        expect(s2calls).toEqual(1)

        // s1 moves to its next node
        s1LockNext.arrivedAt(s1Path.indexOf(nodeC))
        expect(s1NextPaths.at(-1)).toEqual([{index: 1, node: 'c'}, {index: 2, node: 'd'}])
        expect(s2NextPaths.at(-1)).toEqual([{index: 0, node: 'b'}])
        expect(s1calls).toEqual(2)
        expect(s2calls).toEqual(1)

        // s1 moves to its next node again
        s1LockNext.arrivedAt(s1Path.indexOf(nodeD))
        expect(s1NextPaths.at(-1)).toEqual([{index: 2, node: 'd'}, {index: 3, node: 'e'}])
        expect(s2NextPaths.at(-1)).toEqual([{index: 0, node: 'b'}, {index: 1, node: 'c'}]) // nodeC can now be obtained by s2
        expect(s2NextPaths).toEqual([[{index: 0, node: 'b'}], [{index: 0, node: 'b'}, {index: 1, node: 'c'}]]) // nodeC can now be obtained by s2
        expect(s1calls).toEqual(3)
        expect(s2calls).toEqual(2)

        // s1 moves to its next node again
        s1LockNext.arrivedAt(s1Path.indexOf(nodeE))
        expect(s1NextPaths.at(-1)).toEqual([{index: 3, node: 'e'}, {index: 4, node: 'f'}])
        expect(s2NextPaths.at(-1)).toEqual([{index: 0, node: 'b'}, {index: 1, node: 'c'}])
        expect(s2NextPaths).toEqual([[{index: 0, node: 'b'}], [{index: 0, node: 'b'}, {index: 1, node: 'c'}]]) // nodeC can now be obtained by s2
        expect(s1calls).toEqual(4)
        expect(s2calls).toEqual(2)

        // s1 moves to its next node again
        s1LockNext.arrivedAt(s1Path.indexOf(nodeF))
        expect(s1NextPaths.at(-1)).toEqual([{index: 4, node: 'f'}, {index: 5, node: 'g'}])
        expect(s2NextPaths.at(-1)).toEqual([{index: 0, node: 'b'}, {index: 1, node: 'c'}])

        // s2 moves to its next node
        s2LockNext.arrivedAt(s2Path.indexOf(nodeC))
        expect(s1NextPaths.at(-1)).toEqual([{index: 4, node: 'f'}, {index: 5, node: 'g'}])
        expect(s2NextPaths.at(-1)).toEqual([{index: 1, node: 'c'}, {index: 2, node: 'd'}])

        // lets confirm all the locks
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked("agent1")).toBeFalsy()
        expect(nodeC.data.isLocked("agent2")).toBeTruthy()
        expect(nodeD.data.isLocked("agent1")).toBeFalsy()
        expect(nodeD.data.isLocked("agent2")).toBeTruthy()
        expect(nodeE.data.isLocked()).toBeFalsy()
        expect(nodeF.data.isLocked("agent1")).toBeTruthy()
        expect(nodeF.data.isLocked("agent2")).toBeFalsy()
        expect(nodeG.data.isLocked("agent1")).toBeTruthy()
        expect(nodeG.data.isLocked("agent2")).toBeFalsy()
        expect(nodeH.data.isLocked()).toBeFalsy()
        expect(nodeI.data.isLocked()).toBeFalsy()

        expect(linkAC.data.isLocked()).toBeFalsy() // not bidirectional
        expect(linkBC.data.isLocked()).toBeFalsy() // not bidirectional
        expect(linkCD.data.isLocked("agent1")).toBeFalsy()
        expect(linkCD.data.isLocked("agent2")).toBeTruthy()
        expect(linkDE.data.isLocked("agent1")).toBeFalsy()
        expect(linkDE.data.isLocked("agent2")).toBeTruthy()
        expect(linkEF.data.isLocked("agent1")).toBeFalsy()
        expect(linkEF.data.isLocked("agent2")).toBeTruthy()
        expect(linkFG.data.isLocked("agent1")).toBeTruthy()
        expect(linkFG.data.isLocked("agent2")).toBeTruthy()
        expect(linkGH.data.isLocked()).toBeFalsy() // not bidirectional
        expect(linkGI.data.isLocked()).toBeFalsy() // not bidirectional
    })

    test('bidirectional corridor with early exit', () => {
        const graph = ngraphCreateGraph<Lock, LinkLock>()
        const creator = new Graferse<Node<Lock>>(node => node.id as string)

        const makeNode = (id: string) => graph.addNode(id, creator.makeLock(id))
        const nodeA = makeNode('a')
        const nodeB = makeNode('b')
        const nodeC = makeNode('c')
        const nodeD = makeNode('d')
        const nodeE = makeNode('e')

        // A <----> B <----> C <----> D
        //                    \
        //                     v
        //                     E

        const lockAB = creator.makeLinkLock('a', 'b', true)
        const lockBC = creator.makeLinkLock('b', 'c', true)
        const lockCD = creator.makeLinkLock('c', 'd', true)

        const linkAB = graph.addLink('a', 'b', lockAB)
        const linkBC = graph.addLink('b', 'c', lockBC)
        const linkCD = graph.addLink('c', 'd', lockCD)

        const linkDC = graph.addLink('d', 'c', lockCD)
        const linkCB = graph.addLink('c', 'b', lockBC)
        const linkBA = graph.addLink('b', 'a', lockAB)

        const linkCE = graph.addLink('c', 'e', creator.makeLinkLock('c', 'e'))

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const s1Path = pathFinder.find('a', 'e').reverse()

        const makeLocker = creator.makeMakeLocker(node => node.data, getLockForLink)
        var s1ForwardPath: Array<NextNode> = []
        const s1LockNext = makeLocker("agent1").makePathLocker(s1Path)((nextNodes) => { s1ForwardPath = nextNodes })

        // all nodes are unlocked
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeFalsy()
        expect(nodeD.data.isLocked()).toBeFalsy()
        expect(nodeE.data.isLocked()).toBeFalsy()
        // all links are unlocked
        expect(linkAB.data.isLocked()).toBeFalsy()
        expect(linkBC.data.isLocked()).toBeFalsy()
        expect(linkCD.data.isLocked()).toBeFalsy()
        expect(linkDC.data.isLocked()).toBeFalsy()
        expect(linkCB.data.isLocked()).toBeFalsy()
        expect(linkBA.data.isLocked()).toBeFalsy()

        expect(linkCE.data.isLocked()).toBeFalsy()

        expect(s1ForwardPath).toEqual([])

        s1LockNext.arrivedAt(s1Path.indexOf(nodeA))
        // its current and next nodes are locked
        expect(s1ForwardPath).toEqual([{index: 0, node: 'a'}, {index: 1, node: 'b'}])
        expect(nodeA.data.isLocked()).toBeTruthy()
        expect(nodeB.data.isLocked()).toBeTruthy()
        expect(nodeC.data.isLocked()).toBeFalsy()
        expect(nodeD.data.isLocked()).toBeFalsy()
        expect(nodeE.data.isLocked()).toBeFalsy()

        // all links are locked until path ends
        expect(linkAB.data.isLocked()).toBeTruthy()
        expect(linkBC.data.isLocked()).toBeTruthy()
        expect(linkCD.data.isLocked()).toBeFalsy()
        expect(linkDC.data.isLocked()).toBeFalsy()
        expect(linkCB.data.isLocked()).toBeTruthy()
        expect(linkBA.data.isLocked()).toBeTruthy()
        expect(linkCE.data.isLocked()).toBeFalsy()

        // an opposing robot appears
        const s2Path = pathFinder.find('d', 'b').reverse()
        var s2ForwardPath: Array<NextNode> = []
        const s2LockNext = makeLocker("agent2").makePathLocker(s2Path)((nextNodes) => { s2ForwardPath = nextNodes })
        s2LockNext.arrivedAt(s2Path.indexOf(nodeD))

        // but fails to get a lock on the c -> d link because its locked in the opposite direction
        // and therefor fails to lock nodeD
        expect(s2ForwardPath).toEqual([])
        expect(nodeA.data.isLocked("agent1")).toBeTruthy()
        expect(nodeB.data.isLocked("agent1")).toBeTruthy()
        expect(nodeB.data.isLocked("agent2")).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeFalsy()
        expect(nodeD.data.isLocked()).toBeFalsy()
        expect(nodeE.data.isLocked()).toBeFalsy()

        expect(linkAB.data.isLocked("agent1")).toBeTruthy()
        expect(linkBC.data.isLocked("agent1")).toBeTruthy()
        //expect(linkCD.data.isLocked("agent2")).toBeTruthy()
        //expect(linkDC.data.isLocked("agent2")).toBeTruthy()
        expect(linkCB.data.isLocked("agent1")).toBeTruthy()
        expect(linkBA.data.isLocked("agent1")).toBeTruthy()
        expect(linkCE.data.isLocked()).toBeFalsy()

        //console.dir({s2Path}, {depth: null})
        // lets continue down the hallway
        s1LockNext.arrivedAt(s1Path.indexOf(nodeB))
        expect(s1ForwardPath).toEqual([{index: 1, node: 'b'}, {index: 2, node: 'c'}])
        expect(s2ForwardPath).toEqual([])

        s1LockNext.arrivedAt(s1Path.indexOf(nodeC))
        expect(s1ForwardPath).toEqual([{index: 2, node: 'c'}, {index: 3, node: 'e'}])
         // agent2 obtains nodeD just before stepping off bidir lane
        expect(s2ForwardPath).toEqual([{index: 0, node: 'd'}])

        s1LockNext.arrivedAt(s1Path.indexOf(nodeE))
        expect(s1ForwardPath).toEqual([{index: 3, node: 'e'}])
        expect(s2ForwardPath).toEqual([{index: 0, node: 'd'}, {index: 1, node: 'c'}])
    })

    test('three agents bidirectional corridor with early exit', () => {
        const graph = ngraphCreateGraph<Lock, LinkLock>()
        const creator = new Graferse<Node<Lock>>(node => node.id as string)

        const makeNode = (id: string) => graph.addNode(id, creator.makeLock(id))
        const nodeA = makeNode('a')
        const nodeB = makeNode('b')
        const nodeC = makeNode('c')
        const nodeD = makeNode('d')
        const nodeE = makeNode('e')
        const nodeF = makeNode('f')

        //                      F
        //                     ^
        //                    /
        // A <----> B <----> C <---- D
        //                    \
        //                     v
        //                     E

        const lockAB = creator.makeLinkLock('a', 'b', true)
        const lockBC = creator.makeLinkLock('b', 'c', true)

        const linkAB = graph.addLink('a', 'b', lockAB)
        const linkBC = graph.addLink('b', 'c', lockBC)
        const linkCB = graph.addLink('c', 'b', lockBC)
        const linkBA = graph.addLink('b', 'a', lockAB)

        const linkCD = graph.addLink('d', 'c', creator.makeLinkLock('d', 'c'))
        const linkCE = graph.addLink('c', 'e', creator.makeLinkLock('c', 'e'))
        const linkCF = graph.addLink('c', 'f', creator.makeLinkLock('c', 'f'))

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const s1Path = pathFinder.find('a', 'e').reverse()

        const makeLocker = creator.makeMakeLocker(node => node.data, getLockForLink)
        var s1ForwardPath: Array<NextNode> = []
        const s1LockNext = makeLocker("agent1").makePathLocker(s1Path)((nextNodes) => { s1ForwardPath = nextNodes })

        expect(s1ForwardPath).toEqual([])

        s1LockNext.arrivedAt(s1Path.indexOf(nodeA))
        // its current and next nodes are locked
        expect(s1ForwardPath).toEqual([{index: 0, node: 'a'}, {index: 1, node: 'b'}])

        // an opposing robot appears
        const s2Path = pathFinder.find('d', 'a').reverse()
        var s2ForwardPath: Array<NextNode> = []
        const s2LockNext = makeLocker("agent2").makePathLocker(s2Path)((nextNodes) => { s2ForwardPath = nextNodes })
        //console.log({s2Path})
        s2LockNext.arrivedAt(s2Path.indexOf(nodeD))

        // but fails to get a lock on the c -> d link because its locked in the opposite direction
        expect(s2ForwardPath).toEqual([{index: 0, node: 'd'}])

        s1LockNext.arrivedAt(s1Path.indexOf(nodeB))
        expect(s1ForwardPath).toEqual([{index: 1, node: 'b'}, {index: 2, node: 'c'}])
        expect(s2ForwardPath).toEqual([{index: 0, node: 'd'}])

        const s3Path = pathFinder.find('a', 'f').reverse()
        var s3ForwardPath: Array<NextNode> = []
        const s3LockNext = makeLocker("agent3").makePathLocker(s3Path)((nextNodes) => { s3ForwardPath = nextNodes })

        //console.warn('s3 stepping to node a')
        s3LockNext.arrivedAt(s3Path.indexOf(nodeA))
        expect(s1ForwardPath).toEqual([{index: 1, node: 'b'}, {index: 2, node: 'c'}])
        expect(s2ForwardPath).toEqual([{index: 0, node: 'd'}])
        expect(s3ForwardPath).toEqual([{index: 0, node: 'a'}])

        //console.warn('s1 stepping to node c')
        s1LockNext.arrivedAt(s1Path.indexOf(nodeC))
        expect(s1ForwardPath).toEqual([{index: 2, node: 'c'}, {index: 3, node: 'e'}])
        expect(s2ForwardPath).toEqual([{index: 0, node: 'd'}])
        expect(s3ForwardPath).toEqual([{index: 0, node: 'a'}, {index: 1, node: 'b'}])

        //console.warn('s3 stepping to node b')
        s3LockNext.arrivedAt(s3Path.indexOf(nodeB))
        expect(s1ForwardPath).toEqual([{index: 2, node: 'c'}, {index: 3, node: 'e'}])
        expect(s2ForwardPath).toEqual([{index: 0, node: 'd'}])
        expect(s3ForwardPath).toEqual([{index: 1, node: 'b'}])

        //                      F
        //                     ^
        //                    /
        // A <----> B <----> C <---- D
        //                    \
        //                     v
        //                     E
        //console.warn('s1 stepping to node e')
        s1LockNext.arrivedAt(s1Path.indexOf(nodeE))
        expect(s1ForwardPath).toEqual([{index: 3, node: 'e'}])
        expect(s2ForwardPath).toEqual([{index: 0, node: 'd'}])
        expect(s3ForwardPath).toEqual([{index: 1, node: 'b'}, {index: 2, node: 'c'}])
    })
    test('two robots opposing directions never adject nodes', () => {
        //
        //               Y
        //               ^
        //                \
        //                 v
        // A ----> B ----> C <---> D <---> E <---- F <---- G
        //                                 ^
        //                                  \
        //                                   v
        //                                   Z
        const graph = ngraphCreateGraph<Lock, LinkLock>()
        const creator = new Graferse<Node<Lock>>(node => node.id as string)

        const makeNode = (id: string) => graph.addNode(id, creator.makeLock(id))
        const nodeA = makeNode('a')
        const nodeB = makeNode('b')
        const nodeC = makeNode('c')
        const nodeD = makeNode('d')
        const nodeE = makeNode('e')
        const nodeF = makeNode('f')
        const nodeG = makeNode('g')
        const nodeY = makeNode('y')
        const nodeZ = makeNode('z')

        const lockCD = creator.makeLinkLock('c', 'd', true)
        const lockDE = creator.makeLinkLock('d', 'e', true)
        const lockCY = creator.makeLinkLock('c', 'y', true)
        const lockEZ = creator.makeLinkLock('e', 'z', true)

        function addBiLink(a: string, b: string, lock: LinkLock) {
            return [
                graph.addLink(a, b, lock),
                graph.addLink(b, a, lock),
            ]
        }

        graph.addLink('a', 'b', creator.makeLinkLock('a', 'b')),
        graph.addLink('b', 'c', creator.makeLinkLock('b', 'c')),
        addBiLink('c', 'd', lockCD)
        addBiLink('d', 'e', lockDE)
        graph.addLink('g', 'f', creator.makeLinkLock('g', 'f')),
        graph.addLink('f', 'e', creator.makeLinkLock('f', 'e')),
        addBiLink('c', 'y', lockCY)
        addBiLink('e', 'z', lockEZ)

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        // TODO make a fully bidir test
        // robot does not entire bidir path at all unless its path is clear to end
        //
        //               Y
        //               ^
        //                \
        // A <---> B <---> C <---> D <---> E <---> F <----> G
        //                                  \
        //                                   v
        //                                   Z
        const path1 = pathFinder.find('a', 'z').reverse()
        const path2 = pathFinder.find('g', 'y').reverse()

        const makeLocker = creator.makeMakeLocker(node => node.data, getLockForLink)
        var nextNodes1: Array<NextNode> = []
        var nextNodes2: Array<NextNode> = []
        const agent1at = makeLocker("agent1").makePathLocker(path1)((nn) => { nextNodes1 = nn }).lockNext
        const agent2at = makeLocker("agent2").makePathLocker(path2)((nn) => { nextNodes2 = nn }).lockNext

        expect(nextNodes1).toEqual([])
        expect(nextNodes2).toEqual([])

        agent1at('a')
        expect(nextNodes1).toEqual([{index: 0, node: 'a'}, {index: 1, node: 'b'}])
        expect(nextNodes2).toEqual([])

        agent2at('g')
        expect(nextNodes1).toEqual([{index: 0, node: 'a'}, {index: 1, node: 'b'}])
        expect(nextNodes2).toEqual([{index: 0, node: 'g'}, {index: 1, node: 'f'}])

        agent1at('b')
        expect(nextNodes1).toEqual([{index: 1, node: 'b'}, {index: 2, node: 'c'}]) // now we block the way to Y for agent2
        expect(nextNodes2).toEqual([{index: 0, node: 'g'}, {index: 1, node: 'f'}])

        agent2at('f')
        expect(nextNodes1).toEqual([{index: 1, node: 'b'}, {index: 2, node: 'c'}])
        expect(nextNodes2).toEqual([{index: 1, node: 'f'}]) // cant get E because agent1 has clear path to Z

        agent1at('c')
        expect(nextNodes1).toEqual([{index: 2, node: 'c'}, {index: 3, node: 'd'}])
        expect(nextNodes2).toEqual([{index: 1, node: 'f'}])

        agent1at('d')
        expect(nextNodes1).toEqual([{index: 3, node: 'd'}, {index: 4, node: 'e'}])
        expect(nextNodes2).toEqual([{index: 1, node: 'f'}])

        agent1at('e')
        expect(nextNodes1).toEqual([{index: 4, node: 'e'}, {index: 5, node: 'z'}])
        expect(nextNodes2).toEqual([{index: 1, node: 'f'}])

        agent1at('z')
        expect(nextNodes1).toEqual([{index: 5, node: 'z'}])
        expect(nextNodes2).toEqual([{index: 1, node: 'f'}, {index: 2, node: 'e'}]) // now we can move to E
    })
    test('two robots opposing directions never adject nodes - part2', () => {
        //
        //               Y
        //               ^
        //                \
        //                 v
        // A ----> B ----> C <---> D <---> E <----> F <---- G
        //                                 ^
        //                                  \
        //                                   v
        //                                   Z
        const graph = ngraphCreateGraph<Lock, LinkLock>()
        const creator = new Graferse<Node<Lock>>(node => node.id as string)

        const makeNode = (id: string) => graph.addNode(id, creator.makeLock(id))
        const nodeA = makeNode('a')
        const nodeB = makeNode('b')
        const nodeC = makeNode('c')
        const nodeD = makeNode('d')
        const nodeE = makeNode('e')
        const nodeF = makeNode('f')
        const nodeG = makeNode('g')
        const nodeY = makeNode('y')
        const nodeZ = makeNode('z')

        const lockCD = creator.makeLinkLock('c', 'd', true)
        const lockDE = creator.makeLinkLock('d', 'e', true)
        const lockEF = creator.makeLinkLock('e', 'f', true)
        const lockCY = creator.makeLinkLock('c', 'y', true)
        const lockEZ = creator.makeLinkLock('e', 'z', true)

        function addBiLink(a: string, b: string, lock: LinkLock) {
            return [
                graph.addLink(a, b, lock),
                graph.addLink(b, a, lock),
            ]
        }

        graph.addLink('a', 'b', creator.makeLinkLock('a', 'b')),
        graph.addLink('b', 'c', creator.makeLinkLock('b', 'c')),
        addBiLink('c', 'd', lockCD)
        addBiLink('d', 'e', lockDE)
        graph.addLink('g', 'f', creator.makeLinkLock('g', 'f')),
        addBiLink('f', 'e', lockEF),
        addBiLink('c', 'y', lockCY)
        addBiLink('e', 'z', lockEZ)

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        // TODO make a fully bidir test
        // robot does not entire bidir path at all unless its path is clear to end
        //
        //               Y
        //               ^
        //                \
        // A <---> B <---> C <---> D <---> E <---> F <----> G
        //                                  \
        //                                   v
        //                                   Z
        const path1 = pathFinder.find('a', 'z').reverse()
        const path2 = pathFinder.find('g', 'y').reverse()

        const makeLocker = creator.makeMakeLocker(node => node.data, getLockForLink)
        var nextNodes1: Array<NextNode> = []
        var nextNodes2: Array<NextNode> = []
        const agent1at = makeLocker("agent1").makePathLocker(path1)((nn) => { nextNodes1 = nn }).lockNext
        const agent2at = makeLocker("agent2").makePathLocker(path2)((nn) => { nextNodes2 = nn }).lockNext

        expect(nextNodes1).toEqual([])
        expect(nextNodes2).toEqual([])

        agent1at('a')
        expect(nextNodes1).toEqual([{index: 0, node: 'a'}, {index: 1, node: 'b'}])
        expect(nextNodes2).toEqual([])

        agent1at('b')
        expect(nextNodes1).toEqual([{index: 1, node: 'b'}, {index: 2, node: 'c'}]) // now we block the way to Y for agent2
        expect(nextNodes2).toEqual([])

        agent2at('g')
        expect(nextNodes1).toEqual([{index: 1, node: 'b'}, {index: 2, node: 'c'}])
        expect(nextNodes2).toEqual([{index: 0, node: 'g'}])

        agent1at('c')
        expect(nextNodes1).toEqual([{index: 2, node: 'c'}, {index: 3, node: 'd'}])
        expect(nextNodes2).toEqual([{index: 0, node: 'g'}])

        agent1at('d')
        expect(nextNodes1).toEqual([{index: 3, node: 'd'}, {index: 4, node: 'e'}])
        expect(nextNodes2).toEqual([{index: 0, node: 'g'}])

        agent1at('e')
        expect(nextNodes1).toEqual([{index: 4, node: 'e'}, {index: 5, node: 'z'}])
        expect(nextNodes2).toEqual([{index: 0, node: 'g'}, {index: 1, node: 'f'}])  // seems a little early to obtain nodeF

        agent2at('f')
        expect(nextNodes1).toEqual([{index: 4, node: 'e'}, {index: 5, node: 'z'}])
        expect(nextNodes2).toEqual([{index: 1, node: 'f'}]) // cant get E because agent1 is tehre

        agent1at('z')
        expect(nextNodes1).toEqual([{index: 5, node: 'z'}])
        expect(nextNodes2).toEqual([{index: 1, node: 'f'}, {index: 2, node: 'e'}]) // now we can move to E
    })
    // TODO add test that shows we are waiting on distant edge
    //test('two robots opposing directions in a narrow corridor', () => {
    //    const graph = ngraphCreateGraph()
    //    const creator = new Graferse()

    //    const nodeA = graph.addNode('a', creator.makeLock())
    //    const nodeB = graph.addNode('b', creator.makeLock())
    //    const nodeC = graph.addNode('c', creator.makeLock())
    //    const nodeD = graph.addNode('d', creator.makeLock())

    //    // A
    //    //  \
    //    //   ----> C ----> D
    //    //  /
    //    // B
    //    graph.addLink('a', 'c', creator.makeLinkLock('a', 'c'))
    //    graph.addLink('b', 'c', creator.makeLinkLock('b', 'c'))
    //    graph.addLink('c', 'd', creator.makeLinkLock('c', 'd'))

    //    const pathFinder = ngraphPath.aStar(graph, { oriented: true })
    //    const s1Path = pathFinder.find('a', 'd')
    //    const s2Path = pathFinder.find('b', 'c')

    //    const makeLocker = creator.makeMakeLocker<Node<Lock>>(node => node.data, getLockForLink)
    //    var s1ForwardPath: Array<Node<Lock>> = []
    //    var s2ForwardPath: Array<Node<Lock>> = []
    //    const s1LockNext = makeLocker("agent1").makePathLocker(s1Path)((nextNodes) => { s1ForwardPath = nextNodes }).lockNext
    //    const s2LockNext = makeLocker("agent2").makePathLocker(s2Path)((nextNodes) => { s2ForwardPath = nextNodes }).lockNext

    //    // all nodes are unlocked
    //    expect(nodeA.data.isLocked()).toBeFalsy()
    //    expect(nodeB.data.isLocked()).toBeFalsy()
    //    expect(nodeC.data.isLocked()).toBeFalsy()
    //    expect(nodeD.data.isLocked()).toBeFalsy()
    //    expect(s1ForwardPath).toEqual([])
    //    expect(s2ForwardPath).toEqual([])

    //    // moving agent1 to the first node locks it, and the next
    //    s1LockNext(nodeA)
    //    expect(nodeA.data.isLocked("agent1")).toBeTruthy()
    //    expect(nodeB.data.isLocked()).toBeFalsy()
    //    expect(nodeC.data.isLocked("agent1")).toBeTruthy()
    //    expect(nodeD.data.isLocked()).toBeFalsy()
    //    expect(s1ForwardPath).toEqual([nodeC, nodeA])
    //    expect(s2ForwardPath).toEqual([])

    //    // moving agent1 to its first node locks it
    //    // but the second is common to both paths, and already locked
    //    s2LockNext(nodeB)
    //    expect(nodeA.data.isLocked("agent1")).toBeTruthy()
    //    expect(nodeB.data.isLocked("agent2")).toBeTruthy()
    //    expect(nodeC.data.isLocked("agent1")).toBeTruthy()
    //    expect(nodeD.data.isLocked()).toBeFalsy()
    //    expect(s1ForwardPath).toEqual([nodeC, nodeA])
    //    expect(s2ForwardPath).toEqual([nodeB])  // nodeC missing because locked by agent1

    //    // moving agent1 to the last node locks it, and unlocks all prior nodes
    //    // and allows agent2 to progress to NodeC
    //    s1LockNext(nodeD)
    //    expect(nodeA.data.isLocked()).toBeFalsy()
    //    expect(nodeB.data.isLocked("agent2")).toBeTruthy()
    //    expect(nodeC.data.isLocked("agent2")).toBeTruthy()
    //    expect(nodeD.data.isLocked("agent1")).toBeTruthy()
    //    expect(s1ForwardPath).toEqual([nodeD])
    //    expect(s2ForwardPath).toEqual([nodeC, nodeB])
    //})
    test('directed', () => {
        const graph = ngraphCreateGraph()
        const creator = new Graferse<Node<Lock>>(node => node.id as string)

        const makeNode = (id: string) => graph.addNode(id, creator.makeLock(id))
        const nodeA = makeNode('a')
        const nodeB = makeNode('b')
        const nodeC = makeNode('c')
        graph.addLink('a', 'b', creator.makeLock('ab'))
        graph.addLink('b', 'c', creator.makeLock('bc'))
        graph.addLink('c', 'b', creator.makeLock('cb'))
        graph.addLink('b', 'a', creator.makeLock('ba'))

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const path = pathFinder.find('a', 'c').reverse()

        const makeLocker = creator.makeMakeLocker(node => node.data, getLockForLink)
        const lockNext = makeLocker("agent1").makePathLocker(path)((nextNodes) => {})

        for (var i = 0; i < path.length; i++) {
            lockNext.arrivedAt(i)
        }
    })
})

describe('Components', () => {
    describe('Lock', () => {
        test('locking twice', () => {
            const creator = new Graferse<Node>(node => node.id as string)
            const lock = creator.makeLock('lock')
            expect(lock.requestLock('test', 'abc')).toBeTruthy()
            expect(lock.requestLock('test', 'def')).toBeTruthy()
        })
    })

    describe('LinkLock', () => {
        test('locking when directed edge', () => {
            const logSpyWarn = jest.spyOn(console, 'warn').mockImplementation()
            const logSpyError = jest.spyOn(console, 'error').mockImplementation()
            const creator = new Graferse<Node>(node => node.id as string)
            const linkLock = creator.makeLinkLock('up', 'down') // by default is directed edge
            expect(logSpyWarn).not.toHaveBeenCalled()
            expect(logSpyError).not.toHaveBeenCalled()
            expect(linkLock.requestLock('test', 'up')).toEqual("FREE")
            expect(logSpyWarn).toHaveBeenCalled()
            expect(logSpyError).toHaveBeenCalled()

            // needed for bun until resetAllMocks is available
            logSpyWarn.mockReset()
            logSpyError.mockReset()
        })

        describe('Locking in both directions', () => {
            test('single owner can lock both directions', () => {
                const creator = new Graferse<Node>(node => node.id as string)
                const linkLock = creator.makeLinkLock('up', 'down', true) // is bidirectional
                expect(linkLock.requestLock('agent1', 'up')).toEqual("FREE")
                expect(linkLock.requestLock('agent1', 'down')).toEqual("FREE")
            })
            test('owner cannot lock both directions if multiple owners', () => {
                const creator = new Graferse<Node>(node => node.id as string)
                const linkLock = creator.makeLinkLock('up', 'down', true) // is bidirectional
                expect(linkLock.requestLock('agent1', 'up')).toEqual("FREE")
                expect(linkLock.requestLock('agent2', 'up')).toEqual("PRO")
                expect(linkLock.requestLock('agent1', 'down')).toEqual("CON")
            })
            test('agent cannot lock if both directions already locked', () => {
                const creator = new Graferse<Node>(node => node.id as string)
                const linkLock = creator.makeLinkLock('up', 'down', true) // is bidirectional
                expect(linkLock.requestLock('agent1', 'up')).toEqual("FREE")
                expect(linkLock.requestLock('agent1', 'down')).toEqual("FREE")
                expect(linkLock.requestLock('agent2', 'up')).toEqual("CON")

                linkLock.unlock('agent1', 'up')
                expect(linkLock.requestLock('agent2', 'up')).toEqual("CON")

                expect(linkLock.requestLock('agent1', 'up')).toEqual("FREE")
                linkLock.unlock('agent1', 'down')
                expect(linkLock.requestLock('agent2', 'up')).toEqual("PRO")
            })
        })
    })
})

describe('Listeners', () => {
    test('smoke', () => {
        let listenCallbackCounter = 0
        const creator = new Graferse<Node>(node => node.id as string)
        creator.addListener(() => { listenCallbackCounter++ })

        // no one has been called yet
        expect(listenCallbackCounter).toEqual(0)

        // clearAllLocks invokes listeners
        creator.clearAllLocks("test")
        expect(listenCallbackCounter).toEqual(1)

        // notifyWaiters invokes listeners
        creator.notifyWaiters(new Set())
        expect(listenCallbackCounter).toEqual(2)

        // recursive calling of notifyWaiters
        creator.lastCallCache.set("agent1", () => creator.notifyWaiters(new Set()))
        creator.notifyWaiters(new Set(["agent1"]))
        // listener is invoked once for each agent
        expect(listenCallbackCounter).toEqual(4)
    })
})

describe('Exceptions', () => {
    test('node not on path', () => {
        const getLockForLink = (from: Lock, to: Lock) => {
            return creator.makeLinkLock(from.id, to.id)
        }
        const creator = new Graferse<Lock>(node => node.id)
        const nodeA = creator.makeLock('nodeA')
        const nodeB = creator.makeLock('nodeB')
        const nodeC = creator.makeLock('nodeC')
        const nodeX = creator.makeLock('nodeX')

        const makeLocker = creator.makeMakeLocker(
            node => node,
            (from, to) => creator.makeLinkLock(from.id, to.id))

        const test1Path = [nodeA, nodeB, nodeC]
        const test1At = makeLocker("test1").makePathLocker(test1Path)(
            (nextNodes) => {}
        )

        const logSpyError = jest.spyOn(console, 'error').mockImplementation()
        expect(nodeA.isLocked()).toBeFalsy()
        expect(nodeB.isLocked()).toBeFalsy()
        expect(nodeC.isLocked()).toBeFalsy()

        expect(() => test1At.lockNext('nodeB')).not.toThrow()
        expect(() => test1At.arrivedAt(test1Path.indexOf(nodeB))).not.toThrow()
        expect(logSpyError).not.toHaveBeenCalled()
        expect(nodeA.isLocked()).toBeFalsy()
        expect(nodeB.isLocked()).toBeTruthy()
        expect(nodeC.isLocked()).toBeTruthy()

        expect(() => test1At.lockNext('nodeX')).not.toThrow()
        expect(logSpyError).toHaveBeenCalled()
        // and all nodes are unlocked again
        expect(nodeA.isLocked()).toBeFalsy()
        expect(nodeB.isLocked()).toBeFalsy()
        expect(nodeC.isLocked()).toBeFalsy()

        // needed for bun until resetAllMocks is available
        logSpyError.mockReset()
    })
    test('arrivedAt bounds', () => {
        const getLockForLink = (from: Lock, to: Lock) => {
            return creator.makeLinkLock(from.id, to.id)
        }
        const creator = new Graferse<Lock>(node => node?.id)
        const nodeA = creator.makeLock('nodeA')
        const nodeB = creator.makeLock('nodeB')
        const nodeC = creator.makeLock('nodeC')
        const nodeX = creator.makeLock('nodeX')

        const makeLocker = creator.makeMakeLocker(
            node => node,
            (from, to) => creator.makeLinkLock(from.id, to.id))

        const test1Path = [nodeA, nodeB, nodeC]
        var forwardPath: Array<NextNode> = []
        const test1At = makeLocker("test1").makePathLocker(test1Path)(
            (nextNodes) => { forwardPath = nextNodes }
        )

        expect(nodeA.isLocked()).toBeFalsy()
        expect(nodeB.isLocked()).toBeFalsy()
        expect(nodeC.isLocked()).toBeFalsy()
        expect(forwardPath).toEqual([])

        test1At.arrivedAt(-2)
        expect(nodeA.isLocked()).toBeFalsy()
        expect(nodeB.isLocked()).toBeFalsy()
        expect(nodeC.isLocked()).toBeFalsy()
        expect(forwardPath).toEqual([])

        test1At.arrivedAt(-1)
        // first node is locked because the next node is pos 0
        expect(nodeA.isLocked()).toBeTruthy()
        expect(nodeB.isLocked()).toBeFalsy()
        expect(nodeC.isLocked()).toBeFalsy()
        expect(forwardPath).toEqual([{index: 0, node: 'nodeA'}])

        test1At.arrivedAt(3)
        // and all nodes are unlocked again
        expect(nodeA.isLocked()).toBeFalsy()
        expect(nodeB.isLocked()).toBeFalsy()
        expect(nodeC.isLocked()).toBeFalsy()
    })
})
