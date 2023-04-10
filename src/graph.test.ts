import type { Node } from 'ngraph.graph'
import ngraphCreateGraph from 'ngraph.graph'
import ngraphPath from 'ngraph.path'
import { Lock, LinkLock, makeMakeLocker } from './graph.js'

const getLockForLink = (from: Node, to: Node) => {
    const link = Array.from(from.links || []).find(link => link.toId == to.id)
    return link?.data
}

describe('ngraph', () => {
    test('basic locking', () => {
        const graph = ngraphCreateGraph()

        const nodeA = graph.addNode('a', new Lock())
        const nodeB = graph.addNode('b', new Lock())
        const nodeC = graph.addNode('c', new Lock())

        graph.addLink('a', 'b', new Lock())
        graph.addLink('b', 'c', new Lock())

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const path = pathFinder.find('a', 'c').reverse()

        var forwardPath: Array<Node<Lock>> = []
        const makeLocker = makeMakeLocker<Node<Lock>>(node => node.data, getLockForLink)(path)
        const lockNext = makeLocker("agent1", (nextNodes) => { forwardPath = nextNodes })

        // all nodes are unlocked
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeFalsy()
        expect(forwardPath).toEqual([])

        // progressing to the first node locks it, and the next
        lockNext(nodeA)
        expect(nodeA.data.isLocked()).toBeTruthy()
        expect(nodeB.data.isLocked()).toBeTruthy()
        expect(nodeC.data.isLocked()).toBeFalsy()
        expect(forwardPath).toEqual([nodeA, nodeB])

        // progressing to the second node locks it, and the next
        // and unlocks nodes behind it
        lockNext(nodeB)
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeTruthy()
        expect(nodeC.data.isLocked()).toBeTruthy()
        expect(forwardPath).toEqual([nodeB, nodeC])

        // progressing to the last node locks it
        // and unlocks nodes behind it
        lockNext(nodeC)
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeTruthy()
        expect(forwardPath).toEqual([nodeC])

    })

    test('unexpected queue jumping', () => {
        const graph = ngraphCreateGraph()

        const nodeA = graph.addNode('a', new Lock())
        const nodeB = graph.addNode('b', new Lock())
        const nodeC = graph.addNode('c', new Lock())

        graph.addLink('a', 'b', new Lock())
        graph.addLink('b', 'c', new Lock())

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const path = pathFinder.find('a', 'c').reverse()

        var forwardPath: Array<Node<Lock>> = []
        const makeLocker = makeMakeLocker<Node<Lock>>(node => node.data, getLockForLink)(path)
        const lockNext = makeLocker("agent1", (nextNodes) => { forwardPath = nextNodes })

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
        lockNext(nodeC)
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeTruthy()
        expect(forwardPath).toEqual([nodeC])
    })

    test('two robot mutual exclusion', () => {
        const graph = ngraphCreateGraph()

        const nodeA = graph.addNode('a', new Lock())
        const nodeB = graph.addNode('b', new Lock())
        const nodeC = graph.addNode('c', new Lock())
        const nodeD = graph.addNode('d', new Lock())

        // A
        //  \
        //   v
        //   C ----> D
        //   ^
        //  /
        // B
        graph.addLink('a', 'c', new Lock())
        graph.addLink('b', 'c', new Lock())
        graph.addLink('c', 'd', new Lock())

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const s1Path = pathFinder.find('a', 'd').reverse()
        const s2Path = pathFinder.find('b', 'c').reverse()

        var s1ForwardPath: Array<Node<Lock>> = []
        var s2ForwardPath: Array<Node<Lock>> = []
        const makeLocker = makeMakeLocker<Node<Lock>>(node => node.data, getLockForLink)
        const s1LockNext = makeLocker(s1Path)("agent1", (nextNodes) => { s1ForwardPath = nextNodes })
        const s2LockNext = makeLocker(s2Path)("agent2", (nextNodes) => { s2ForwardPath = nextNodes })

        // all nodes are unlocked
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeFalsy()
        expect(nodeD.data.isLocked()).toBeFalsy()
        expect(s1ForwardPath).toEqual([])
        expect(s2ForwardPath).toEqual([])

        // moving agent1 to the first node locks it, and the next
        s1LockNext(nodeA)
        expect(nodeA.data.isLocked("agent1")).toBeTruthy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked("agent1")).toBeTruthy()
        expect(nodeD.data.isLocked()).toBeFalsy()
        expect(s1ForwardPath).toEqual([nodeA, nodeC])
        expect(s2ForwardPath).toEqual([])

        // moving agent1 to its first node locks it
        // but the second is common to both paths, and already locked
        s2LockNext(nodeB)
        expect(nodeA.data.isLocked("agent1")).toBeTruthy()
        expect(nodeB.data.isLocked("agent2")).toBeTruthy()
        expect(nodeC.data.isLocked("agent1")).toBeTruthy()
        expect(nodeD.data.isLocked()).toBeFalsy()
        expect(s1ForwardPath).toEqual([nodeA, nodeC])
        expect(s2ForwardPath).toEqual([nodeB])  // nodeC missing because locked by agent1

        // moving agent1 to the last node locks it, and unlocks all prior nodes
        // and allows agent2 to progress to NodeC
        s1LockNext(nodeD)
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked("agent2")).toBeTruthy()
        expect(nodeC.data.isLocked("agent2")).toBeTruthy()
        expect(nodeD.data.isLocked("agent1")).toBeTruthy()
        expect(s1ForwardPath).toEqual([nodeD])
        expect(s2ForwardPath).toEqual([nodeB, nodeC])
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

        const nodeA = graph.addNode('a', new Lock())
        const nodeB = graph.addNode('b', new Lock())
        const nodeC = graph.addNode('c', new Lock())
        const nodeD = graph.addNode('d', new Lock())
        const nodeE = graph.addNode('e', new Lock())
        const nodeF = graph.addNode('f', new Lock())
        const nodeG = graph.addNode('g', new Lock())
        const nodeH = graph.addNode('h', new Lock())
        const nodeI = graph.addNode('i', new Lock())

        // B                                        H
        //  \                                       ^
        //   v                                     /
        //    C <----> D <----> E <----> F <----> G
        //   ^                                     \
        //  /                                       v
        // A                                        I

        // bidirectional locks
        const lockCD = new LinkLock(true)
        const lockDE = new LinkLock(true)
        const lockEF = new LinkLock(true)
        const lockFG = new LinkLock(true)

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
        const linkAC = graph.addLink('a', 'c', new LinkLock())
        const linkBC = graph.addLink('b', 'c', new LinkLock())
        const linkGH = graph.addLink('g', 'h', new LinkLock())
        const linkGI = graph.addLink('g', 'i', new LinkLock())

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const s1Path = pathFinder.find('a', 'h').reverse()
        const s2Path = pathFinder.find('b', 'i').reverse()

        const makeLocker = makeMakeLocker<Node<Lock>>(
            node => node.data,
            getLockForLink,
            x => x.id,
            x => x.id
        )
        var s1NextPath: Array<Node<Lock>> = []
        var s2NextPath: Array<Node<Lock>> = []
        const s1LockNext = makeLocker(s1Path)("agent1", (nextNodes) => { s1NextPath = nextNodes })
        const s2LockNext = makeLocker(s2Path)("agent2", (nextNodes) => { s2NextPath = nextNodes })

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
        expect(s1NextPath).toEqual([])
        expect(s2NextPath).toEqual([])

        s1LockNext('a')
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

        expect(s1NextPath).toEqual([nodeA, nodeC])

        // a following robot appears
        s2LockNext('b')

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

        expect(s2NextPath).toEqual([nodeB])

        // s1 moves to its next node
        s1LockNext('c')
        expect(s1NextPath).toEqual([nodeC, nodeD])
        expect(s2NextPath).toEqual([nodeB])

        // s1 moves to its next node again
        s1LockNext('d')
        expect(s1NextPath).toEqual([nodeD, nodeE])
        expect(s2NextPath).toEqual([nodeB, nodeC]) // nodeC can now be obtained by s2

        // s1 moves to its next node again
        s1LockNext('e')
        expect(s1NextPath).toEqual([nodeE, nodeF])
        expect(s2NextPath).toEqual([nodeB, nodeC])

        // s1 moves to its next node again
        s1LockNext('f')
        expect(s1NextPath).toEqual([nodeF, nodeG])
        expect(s2NextPath).toEqual([nodeB, nodeC])

        // s2 moves to its next node
        s2LockNext('c')
        expect(s1NextPath).toEqual([nodeF, nodeG])
        expect(s2NextPath).toEqual([nodeC, nodeD])

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
        expect(linkFG.data.isLocked("agent2")).toBeFalsy()
        expect(linkGH.data.isLocked()).toBeFalsy() // not bidirectional
        expect(linkGI.data.isLocked()).toBeFalsy() // not bidirectional
    })

    test('bidirectional corridor with early exit', () => {
        const graph = ngraphCreateGraph<Lock, LinkLock>()

        const nodeA = graph.addNode('a', new Lock())
        const nodeB = graph.addNode('b', new Lock())
        const nodeC = graph.addNode('c', new Lock())
        const nodeD = graph.addNode('d', new Lock())
        const nodeE = graph.addNode('e', new Lock())

        // A <----> B <----> C <----> D
        //                    \
        //                     v
        //                     E

        const lockAB = new LinkLock(true)
        const lockBC = new LinkLock(true)
        const lockCD = new LinkLock(true)

        const linkAB = graph.addLink('a', 'b', lockAB)
        const linkBC = graph.addLink('b', 'c', lockBC)
        const linkCD = graph.addLink('c', 'd', lockCD)

        const linkDC = graph.addLink('d', 'c', lockCD)
        const linkCB = graph.addLink('c', 'b', lockBC)
        const linkBA = graph.addLink('b', 'a', lockAB)

        const linkCE = graph.addLink('c', 'e', new LinkLock())

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const s1Path = pathFinder.find('a', 'e').reverse()

        const makeLocker = makeMakeLocker<Node<Lock>>(node => node.data, getLockForLink)
        var s1ForwardPath: Array<Node<Lock>> = []
        const s1LockNext = makeLocker(s1Path)("agent1", (nextNodes) => { s1ForwardPath = nextNodes })

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

        s1LockNext(nodeA)
        // its current and next nodes are locked
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

        console.log("=========================================================")
        // an opposing robot appears
        const s2Path = pathFinder.find('d', 'b').reverse()
        var s2ForwardPath: Array<Node<Lock>> = []
        const s2LockNext = makeLocker(s2Path)("agent2", (nextNodes) => { s2ForwardPath = nextNodes })
        s2LockNext(nodeD)

        // but fails to get a lock on the c -> d link because its locked in the opposite direction
        expect(nodeA.data.isLocked("agent1")).toBeTruthy()
        expect(nodeB.data.isLocked("agent1")).toBeTruthy()
        expect(nodeB.data.isLocked("agent2")).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeFalsy()
        expect(nodeD.data.isLocked()).toBeTruthy()
        expect(nodeE.data.isLocked()).toBeFalsy()

        expect(linkAB.data.isLocked("agent1")).toBeTruthy()
        expect(linkBC.data.isLocked("agent1")).toBeTruthy()
        expect(linkCD.data.isLocked("agent2")).toBeTruthy()
        expect(linkDC.data.isLocked("agent2")).toBeTruthy()
        expect(linkCB.data.isLocked("agent1")).toBeTruthy()
        expect(linkBA.data.isLocked("agent1")).toBeTruthy()
        expect(linkCE.data.isLocked()).toBeFalsy()

        console.dir({s2Path}, {depth: null})

    })

    //test('two robots opposing directions in a narrow corridor', () => {
    //    const graph = ngraphCreateGraph()

    //    const nodeA = graph.addNode('a', new Lock())
    //    const nodeB = graph.addNode('b', new Lock())
    //    const nodeC = graph.addNode('c', new Lock())
    //    const nodeD = graph.addNode('d', new Lock())

    //    // A
    //    //  \
    //    //   ----> C ----> D
    //    //  /
    //    // B
    //    graph.addLink('a', 'c', new Lock())
    //    graph.addLink('b', 'c', new Lock())
    //    graph.addLink('c', 'd', new Lock())

    //    const pathFinder = ngraphPath.aStar(graph, { oriented: true })
    //    const s1Path = pathFinder.find('a', 'd')
    //    const s2Path = pathFinder.find('b', 'c')

    //    const makeLocker = makeMakeLocker<Node<Lock>>(node => node.data, getLockForLink)
    //    var s1ForwardPath: Array<Node<Lock>> = []
    //    var s2ForwardPath: Array<Node<Lock>> = []
    //    const s1LockNext = makeLocker(s1Path)("agent1", (nextNodes) => { s1ForwardPath = nextNodes })
    //    const s2LockNext = makeLocker(s2Path)("agent2", (nextNodes) => { s2ForwardPath = nextNodes })

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

        graph.addNode('a', new Lock())
        graph.addNode('b', new Lock())
        graph.addNode('c', new Lock())
        graph.addLink('a', 'b', new Lock())
        graph.addLink('b', 'c', new Lock())
        graph.addLink('c', 'b', new Lock())
        graph.addLink('b', 'a', new Lock())

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const path = pathFinder.find('a', 'c').reverse()

        const makeLocker = makeMakeLocker<Node<Lock>>(node => node.data, getLockForLink)
        const lockNext = makeLocker(path)("agent1", (nextNodes) => {})

        for (var i = 0; i < path.length; i++) {
            lockNext(path[i])
        }
    })
})
