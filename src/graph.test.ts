import type { Node } from 'ngraph.graph'
import ngraphCreateGraph from 'ngraph.graph'
import ngraphPath from 'ngraph.path'
import { Graferse } from './graph.js'
import type { Lock, LinkLock, NextNode } from './graph.js'

const getLockForLink = (from: Node, to: Node) => {
    const link = Array.from(from.links || []).find(link => link.toId == to.id)
    return link?.data
}

// the removed lockNext took a node id, where arrivedAt takes a path index
const arriveByNodeId = (arrivedAt: (i: number) => void, path: Array<Node<Lock>>) =>
    (id: string) => arrivedAt(path.findIndex(node => node.id === id))

// Strict: never invent a link. A path that walks an edge the fixture never
// defined is a bug in the test, not something to paper over.
const requireLinkLock = <T>(
    creator: Graferse<T>,
    getLock: (x: T) => Lock,
    from: T, to: T,
) => {
    const a = getLock(from).id
    const b = getLock(to).id
    const lock = creator.linkLocks.find(l =>
        (l.from === a && l.to === b) || (l.from === b && l.to === a))
    if (!lock) throw new Error(`no link lock for ${a} -> ${b}`)
    return lock
}

describe('Graferse class', () => {
    test('creating locks', () => {
        const creator = new Graferse<Node>(node => node.id)
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
    test('removing locks', () => {
        const creator = new Graferse<Node>(node => node.id)
        const lock = creator.makeLock('lock1')
        const busy = creator.makeLock('busy')
        const free = creator.makeLinkLock('a', 'b')
        const held = creator.makeLinkLock('b', 'c', true)

        // idle removal drops them from the sweep lists once
        expect(creator.removeLock(lock)).toBe(true)
        expect(creator.removeLock(lock)).toBe(false)
        expect(creator.removeLinkLock(free)).toBe(true)
        expect(creator.removeLinkLock(free)).toBe(false)
        expect(creator.locks).toEqual([busy])
        expect(creator.linkLocks).toEqual([held])

        // held or waited-on locks stay, or waiters would never be granted
        held.requestLock('agent1', 'b')
        expect(() => creator.removeLinkLock(held)).toThrow(/still held or waited on/)

        busy.forceLock('agent2')
        expect(() => creator.removeLock(busy)).toThrow(/still held or waited on/)
        busy.unlock('agent2')
        expect(creator.removeLock(busy)).toBe(true)
        expect(creator.locks).toEqual([])
    })
    test('a lock in a lock group cannot be removed', () => {
        const creator = new Graferse<Node>(node => node.id)
        const lock1 = creator.makeLock('lock1')
        const lock2 = creator.makeLock('lock2')
        creator.setLockGroup([lock1, lock2])

        expect(() => creator.removeLock(lock1)).toThrow(/lock group/)
        expect(creator.locks).toEqual([lock1, lock2])
    })
    test('lock groups', () => {
        const creator = new Graferse<Node>(node => node.id)
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
    test('an abandoned path is not revived by a lock group waiter', () => {
        const creator = new Graferse<Lock>(lock => names.get(lock) as string)
        const getLockForLink = (from: Lock, to: Lock) => requireLinkLock(creator, (x: Lock) => x, from, to)

        const nodeA = creator.makeLock('nodeA')
        const nodeB = creator.makeLock('nodeB')
        const nodeX = creator.makeLock('nodeX')
        const nodeY = creator.makeLock('nodeY')
        // populated after construction, else creator and names would each
        // need the other's type to be inferred
        const names = new Map<Lock,string>()
        names.set(nodeA, 'nodeA')
        names.set(nodeB, 'nodeB')
        names.set(nodeX, 'nodeX')
        names.set(nodeY, 'nodeY')

        creator.makeLinkLock('nodeA', 'nodeB')
        creator.makeLinkLock('nodeX', 'nodeY')

        // nodeB and nodeY exclude each other, but sit on separate paths
        creator.setLockGroup([nodeB, nodeY])

        const makeLocker = creator.makeMakeLocker(node => node, getLockForLink)
        const path1 = [nodeA, nodeB]
        const path2 = [nodeX, nodeY]

        const agent1At = makeLocker('agent1').makePathLocker(path1)((_: NextNode[]) => {})
        const agent2At = makeLocker('agent2').makePathLocker(path2)((_: NextNode[]) => {})

        // agent2 takes nodeX and nodeY
        agent2At.arrivedAt(0)
        expect(nodeX.isLocked()).toBeTruthy()
        expect(nodeY.isLocked()).toBeTruthy()

        // agent1 takes nodeA, is blocked at nodeB, and waits on nodeY,
        // which is not on its own path
        agent1At.arrivedAt(0)
        expect(nodeA.isLocked()).toBeTruthy()
        expect(nodeB.isLocked()).toBeFalsy()
        expect(nodeY.waiting.has('agent1')).toBeTruthy()

        // agent1 gives up its path entirely
        agent1At.clearAllPathLocks()
        expect(nodeA.isLocked()).toBeFalsy()
        expect(nodeB.isLocked()).toBeFalsy()
        expect(nodeY.waiting.has('agent1')).toBeFalsy()

        // releasing nodeY must not replay agent1's dead path
        agent2At.clearAllPathLocks()
        expect(nodeA.isLocked()).toBeFalsy()
        expect(nodeB.isLocked()).toBeFalsy()
        expect(nodeX.isLocked()).toBeFalsy()
        expect(nodeY.isLocked()).toBeFalsy()
    })
    test('an abandoned path is not revived by a link waiter', () => {
        // a <-> b <-> c, both links bidirectional
        const creator = new Graferse<string>(x => x)
        const locks = new Map(['a', 'b', 'c'].map(id => [id, creator.makeLock(id)]))
        const ab = creator.makeLinkLock('a', 'b', true)
        const bc = creator.makeLinkLock('b', 'c', true)
        const links = new Map([
            ['a>b', ab],
            ['b>a', ab],
            ['b>c', bc],
            ['c>b', bc],
        ])
        const makeLocker = creator.makeMakeLocker(
            (x: string) => locks.get(x)!,
            (from: string, to: string) => links.get(`${from}>${to}`)!,
        )

        const agent1At = makeLocker('agent1').makePathLocker(['a', 'b', 'c'])((_: NextNode[]) => {})
        const agent2At = makeLocker('agent2').makePathLocker(['c', 'b', 'a'])((_: NextNode[]) => {})

        // agent1 claims the corridor against the run
        agent1At.arrivedAt(0)
        // agent2 meets it on the b<->c link and waits there
        agent2At.arrivedAt(0)
        expect(bc.isWaiting('agent2')).toBeTruthy()

        // agent2 gives up: its wait on the link must go with the path
        agent2At.clearAllPathLocks()
        expect(bc.isWaiting('agent2')).toBeFalsy()

        // releasing the link must not replay agent2's dead path
        expect(() => agent1At.clearAllPathLocks()).not.toThrow()
    })
    test('clearAllLocks drops a link waiter with no path to replay', () => {
        const creator = new Graferse<string>(x => x)
        const locks = new Map(['a', 'b', 'c'].map(id => [id, creator.makeLock(id)]))
        const ab = creator.makeLinkLock('a', 'b', true)
        const bc = creator.makeLinkLock('b', 'c', true)
        const links = new Map([
            ['a>b', ab],
            ['b>a', ab],
            ['b>c', bc],
            ['c>b', bc],
        ])
        const makeLocker = creator.makeMakeLocker(
            (x: string) => locks.get(x)!,
            (from: string, to: string) => links.get(`${from}>${to}`)!,
        )

        makeLocker('agent1').makePathLocker(['a', 'b', 'c'])((_: NextNode[]) => {}).arrivedAt(0)
        makeLocker('agent2').makePathLocker(['c', 'b', 'a'])((_: NextNode[]) => {}).arrivedAt(0)
        expect(bc.isWaiting('agent2')).toBeTruthy()

        creator.clearAllLocks('agent2')
        expect(bc.isWaiting('agent2')).toBeFalsy()
    })
    test('clearAllExceptLastPathLocks keeps the node the agent sits on', () => {
        const creator = new Graferse<Lock>(lock => names.get(lock) as string)
        const getLockForLink = (from: Lock, to: Lock) => requireLinkLock(creator, (x: Lock) => x, from, to)

        const nodeA = creator.makeLock('nodeA')
        const nodeB = creator.makeLock('nodeB')
        const nodeX = creator.makeLock('nodeX')
        const names = new Map<Lock,string>()
        names.set(nodeA, 'nodeA')
        names.set(nodeB, 'nodeB')
        names.set(nodeX, 'nodeX')

        creator.makeLinkLock('nodeA', 'nodeB')
        creator.makeLinkLock('nodeX', 'nodeB')

        const makeLocker = creator.makeMakeLocker(node => node, getLockForLink)
        const agent1At = makeLocker('agent1').makePathLocker([nodeA, nodeB])((_: NextNode[]) => {})
        const agent2At = makeLocker('agent2').makePathLocker([nodeX, nodeB])((_: NextNode[]) => {})

        agent1At.arrivedAt(0)
        agent1At.arrivedAt(1)
        agent2At.arrivedAt(0)
        expect(nodeB.isLocked()).toBeTruthy()

        // finishing the path keeps nodeB: agent2 still cannot have it
        agent1At.clearAllExceptLastPathLocks()
        expect(nodeA.isLocked()).toBeFalsy()
        expect(nodeB.isLocked('agent1')).toBeTruthy()
        expect(nodeB.isLocked('agent2')).toBeFalsy()

        // giving up entirely hands nodeB to the waiting agent2
        creator.clearAllLocks('agent1')
        expect(nodeB.isLocked('agent1')).toBeFalsy()
        expect(nodeB.isLocked('agent2')).toBeTruthy()
    })
    describe('findLockGroupConflicts', () => {
        // Two lock groups joined by edges running in both directions.  Each
        // group is one physical cell that only one agent may occupy.
        //
        //          group P                     group Q
        //     +-----------------+         +-----------------+
        //  X->|      westP      |-------->|      westQ      |
        //     |      eastP      |<--------|      eastQ      |
        //     +-----------------+         +-----------------+
        //
        //  agent1:  X -> westP -> westQ       enters P, then Q
        //  agent2:       eastQ -> eastP       enters Q, then P
        const buildCells = () => {
            const creator = new Graferse<Lock>(lock => names.get(lock) as string)
            const X     = creator.makeLock('X')
            const westP = creator.makeLock('westP')
            const westQ = creator.makeLock('westQ')
            const eastQ = creator.makeLock('eastQ')
            const eastP = creator.makeLock('eastP')
            const names = new Map<Lock,string>()
            names.set(X, 'X')
            names.set(westP, 'westP')
            names.set(westQ, 'westQ')
            names.set(eastQ, 'eastQ')
            names.set(eastP, 'eastP')
            creator.makeLinkLock('X', 'westP')
            creator.makeLinkLock('westP', 'westQ')
            creator.makeLinkLock('eastQ', 'eastP')
            creator.makeLinkLock('eastP', 'eastQ')
            return { creator, X, westP, westQ, eastQ, eastP, names }
        }

        test('flags two groups joined in both directions', () => {
            const { creator, X, westP, westQ, eastQ, eastP, names } = buildCells()
            creator.setLockGroup([westP, eastP])
            creator.setLockGroup([westQ, eastQ])

            const conflicts = creator.findLockGroupConflicts([
                [X, westP], [westP, westQ], [eastQ, eastP],
            ])

            expect(conflicts).toHaveLength(1)
            expect(conflicts[0].groups).toEqual([[westP, eastP], [westQ, eastQ]])
            expect(conflicts[0].edges.map(e => e.map(l => names.get(l))))
                .toEqual([['westP', 'westQ'], ['eastQ', 'eastP']])
        })

        test('accepts the same groups when traffic runs one way', () => {
            const { creator, X, westP, westQ, eastQ, eastP } = buildCells()
            creator.setLockGroup([westP, eastP])
            creator.setLockGroup([westQ, eastQ])

            // drop the return edge, so nothing crosses back from Q to P
            expect(creator.findLockGroupConflicts([
                [X, westP], [westP, westQ], [eastP, eastQ],
            ])).toEqual([])
        })

        test('ignores edges inside one group, and groups with no edges', () => {
            const { creator, westP, eastP, westQ, eastQ } = buildCells()
            creator.setLockGroup([westP, eastP])
            creator.setLockGroup([westQ, eastQ])

            expect(creator.findLockGroupConflicts([
                [westP, eastP], [eastP, westP],
            ])).toEqual([])
            expect(creator.findLockGroupConflicts([])).toEqual([])
        })

        test('setTopology reserves through the pair and prevents the deadlock', () => {
            const { creator, X, westP, westQ, eastQ, eastP } = buildCells()
            creator.setLockGroup([westP, eastP])
            creator.setLockGroup([westQ, eastQ])
            expect(creator.setTopology([[X, westP], [westP, westQ], [eastQ, eastP]]))
                .toHaveLength(1)

            const makeLocker = creator.makeMakeLocker(
                node => node,
                (from: Lock, to: Lock) => requireLinkLock(creator, (x: Lock) => x, from, to),
            )
            let seen1: string[] = [], seen2: string[] = []
            const agent1 = makeLocker('agent1').makePathLocker([X, westP, westQ])(
                nn => { seen1 = nn.map(n => String(n.node)) })
            const agent2 = makeLocker('agent2').makePathLocker([eastQ, eastP])(
                nn => { seen2 = nn.map(n => String(n.node)) })

            agent1.arrivedAt(0)
            expect(seen1).toEqual(['X', 'westP'])

            // agent2 is refused cell Q now, because cell P beyond it is taken
            agent2.arrivedAt(0)
            expect(seen2).toEqual([])
            expect(eastQ.isLocked()).toBeFalsy()

            // so agent1 runs the corridor to the end and lets go
            agent1.arrivedAt(1)
            expect(seen1).toEqual(['westP', 'westQ'])
            agent1.arrivedAt(2)
            expect(seen1).toEqual(['westQ'])
            agent1.clearAllPathLocks()

            // and agent2 then gets the whole way through
            agent2.arrivedAt(0)
            expect(seen2).toEqual(['eastQ', 'eastP'])
            agent2.arrivedAt(1)
            expect(seen2).toEqual(['eastP'])
        })

        test('opting out keeps the old behaviour', () => {
            const { creator, X, westP, westQ, eastQ, eastP } = buildCells()
            creator.setLockGroup([westP, eastP])
            creator.setLockGroup([westQ, eastQ])
            creator.setTopology(
                [[X, westP], [westP, westQ], [eastQ, eastP]],
                { reserveThroughLockGroups: false },
            )

            const makeLocker = creator.makeMakeLocker(
                node => node,
                (from: Lock, to: Lock) => requireLinkLock(creator, (x: Lock) => x, from, to),
            )
            let seen2: string[] = []
            const agent1 = makeLocker('agent1').makePathLocker([X, westP, westQ])(() => {})
            const agent2 = makeLocker('agent2').makePathLocker([eastQ, eastP])(
                nn => { seen2 = nn.map(n => String(n.node)) })

            agent1.arrivedAt(0)
            agent2.arrivedAt(0)
            // still let into cell Q it cannot leave
            expect(seen2).toEqual(['eastQ'])
        })

        test('a one way group pair is not reserved through', () => {
            const { creator, X, westP, westQ, eastQ, eastP } = buildCells()
            creator.setLockGroup([westP, eastP])
            creator.setLockGroup([westQ, eastQ])
            // no edge crosses back from Q to P, so there is no quotient edge
            expect(creator.setTopology([[X, westP], [westP, westQ], [eastP, eastQ]]))
                .toEqual([])
            expect(creator.crossesQuotientEdge(westP, westQ)).toBeFalsy()

            const makeLocker = creator.makeMakeLocker(
                node => node,
                (from: Lock, to: Lock) => requireLinkLock(creator, (x: Lock) => x, from, to),
            )
            let seen2: string[] = []
            const agent1 = makeLocker('agent1').makePathLocker([X, westP, westQ])(() => {})
            const agent2 = makeLocker('agent2').makePathLocker([eastQ, eastP])(
                nn => { seen2 = nn.map(n => String(n.node)) })

            agent1.arrivedAt(0)
            // agent2 keeps its old freedom to enter Q, nothing can wedge here
            agent2.arrivedAt(0)
            expect(seen2).toEqual(['eastQ'])
        })

        test('without setTopology the rejected network still deadlocks', () => {
            const { creator, X, westP, westQ, eastQ, eastP } = buildCells()
            creator.setLockGroup([westP, eastP])
            creator.setLockGroup([westQ, eastQ])
            const edges: Array<[Lock, Lock]> = [[X, westP], [westP, westQ], [eastQ, eastP]]
            expect(creator.findLockGroupConflicts(edges)).toHaveLength(1)

            const makeLocker = creator.makeMakeLocker(
                node => node,
                (from: Lock, to: Lock) => requireLinkLock(creator, (x: Lock) => x, from, to),
            )
            let seen1: string[] = [], seen2: string[] = []
            const agent1 = makeLocker('agent1').makePathLocker([X, westP, westQ])(
                nn => { seen1 = nn.map(n => String(n.node)) })
            const agent2 = makeLocker('agent2').makePathLocker([eastQ, eastP])(
                nn => { seen2 = nn.map(n => String(n.node)) })

            agent1.arrivedAt(0)              // holds X and cell P
            expect(seen1).toEqual(['X', 'westP'])
            agent2.arrivedAt(0)              // granted cell Q, can never reach P
            expect(seen2).toEqual(['eastQ'])
            agent1.arrivedAt(1)              // moves into P, releasing X
            expect(seen1).toEqual(['westP'])

            // each holds the cell the other needs, and X stands empty
            expect(X.isLocked()).toBeFalsy()
            for (let round = 0; round < 5; round++) {
                agent1.arrivedAt(1)
                agent2.arrivedAt(0)
            }
            expect(seen1).toEqual(['westP'])
            expect(seen2).toEqual(['eastQ'])
        })
    })

    test('clearAllLocks', () => {
        const creator = new Graferse<Node>(node => node.id)
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
        // and no call to arrivedAt exists to call again
        expect(() => creator.clearAllLocks("agent1")).toThrow()

        // but now agent2 can obtain the lock
        expect(lock1.requestLock("agent2", "lock1")).toBeTruthy()
    })
})

describe('no dependencies', () => {
    test('basic locking with identities', () => {
        const getLockForLink = (from: Lock, to: Lock) =>
            requireLinkLock(creator, (x: Lock) => x, from, to)
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

        creator.makeLinkLock('nodeA', 'nodeB')
        creator.makeLinkLock('nodeB', 'nodeC')
        creator.makeLinkLock('nodeX', 'nodeB')
        creator.makeLinkLock('nodeB', 'nodeY')

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
        expect(nodeA.isLocked()).toBeFalsy()
        expect(nodeB.isLocked()).toBeTruthy()
        expect(nodeC.isLocked()).toBeFalsy()

        expect(nodeX.isLocked()).toBeTruthy()
        expect(nodeB.isLocked()).toBeTruthy()
        expect(nodeY.isLocked()).toBeFalsy()

        test2At.clearAllPathLocks()
        expect(nodeA.isLocked()).toBeFalsy()
        expect(nodeB.isLocked()).toBeFalsy()
        expect(nodeC.isLocked()).toBeFalsy()

        expect(nodeX.isLocked()).toBeFalsy()
        expect(nodeB.isLocked()).toBeFalsy()
        expect(nodeY.isLocked()).toBeFalsy()
    })

    test('basic locking', () => {
        const getLockForLink = (from: Lock, to: Lock) =>
            requireLinkLock(creator, (x: Lock) => x, from, to)
        const creator = new Graferse<Lock>(node => node.id)
        const nodeA = creator.makeLock('nodeA')
        const nodeB = creator.makeLock('nodeB')
        const nodeC = creator.makeLock('nodeC')
        const path1 = [nodeA, nodeB, nodeC]

        const nodeX = creator.makeLock('nodeX')
        const nodeY = creator.makeLock('nodeY')
        const path2 = [nodeX, nodeB, nodeY]

        creator.makeLinkLock('nodeA', 'nodeB')
        creator.makeLinkLock('nodeB', 'nodeC')
        creator.makeLinkLock('nodeX', 'nodeB')
        creator.makeLinkLock('nodeB', 'nodeY')

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
        expect(nodeA.isLocked()).toBeFalsy()
        expect(nodeB.isLocked()).toBeTruthy()
        expect(nodeC.isLocked()).toBeFalsy()

        expect(nodeX.isLocked()).toBeTruthy()
        expect(nodeB.isLocked()).toBeTruthy()
        expect(nodeY.isLocked()).toBeFalsy()

        test2At.clearAllPathLocks()
        expect(nodeA.isLocked()).toBeFalsy()
        expect(nodeB.isLocked()).toBeFalsy()
        expect(nodeC.isLocked()).toBeFalsy()

        expect(nodeX.isLocked()).toBeFalsy()
        expect(nodeB.isLocked()).toBeFalsy()
        expect(nodeY.isLocked()).toBeFalsy()
    })
})

describe('ngraph', () => {
    test('basic locking', () => {
        const graph = ngraphCreateGraph()
        const creator = new Graferse<Node<Lock>>(node => node.id)

        const makeNode = (id: string) => graph.addNode(id, creator.makeLock(id))
        const nodeA = makeNode('a')
        const nodeB = makeNode('b')
        const nodeC = makeNode('c')

        graph.addLink('a', 'b', creator.makeLock('ab'))
        graph.addLink('b', 'c', creator.makeLock('bc'))

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const path = pathFinder.find('a', 'c').reverse()

        let forwardPath: Array<NextNode> = []
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
        const creator = new Graferse<Node<Lock>>(node => node.id)

        const makeNode = (id: string) => graph.addNode(id, creator.makeLock(id))
        const nodeA = makeNode('a')
        const nodeB = makeNode('b')
        const nodeC = makeNode('c')

        graph.addLink('a', 'b', creator.makeLock('ab'))
        graph.addLink('b', 'c', creator.makeLock('bc'))

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const path = pathFinder.find('a', 'c').reverse()

        const makeLocker = creator.makeMakeLocker(node => node.data, getLockForLink)("agent1").makePathLocker
        let forwardPath: Array<NextNode> = []
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
        const creator = new Graferse<Node<Lock>>(node => node.id)

        const makeNode = (id: string) => graph.addNode(id, creator.makeLock(id))
        const nodeA = makeNode('a')
        const nodeB = makeNode('b')
        const nodeC = makeNode('c')

        graph.addLink('a', 'b', creator.makeLock('ab'))
        graph.addLink('b', 'c', creator.makeLock('bc'))

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const path = pathFinder.find('a', 'c').reverse()

        let forwardPath: Array<NextNode> = []
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
        const creator = new Graferse<Node<Lock>>(node => node.id)

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
        graph.addLink('a', 'c', creator.makeLinkLock('a', 'c'))
        graph.addLink('b', 'c', creator.makeLinkLock('b', 'c'))
        graph.addLink('c', 'd', creator.makeLinkLock('c', 'd'))

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const s1Path = pathFinder.find('a', 'd').reverse()
        const s2Path = pathFinder.find('b', 'c').reverse()

        let s1ForwardPath: Array<NextNode> = []
        let s2ForwardPath: Array<NextNode> = []
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
        //
        // Two agents cross through the single bidirectional corridor:
        // one enters at A and leaves at G, the other enters at H and
        // leaves at B.  They want each other's side of the map.
        const graph = ngraphCreateGraph<Lock, LinkLock>()
        const creator = new Graferse<Node<Lock>>(node => node.id)

        const makeNode = (id: string) => graph.addNode(id, creator.makeLock(id))
        const nodeA = makeNode('a')
        const nodeB = makeNode('b')
        const nodeC = makeNode('c')
        const nodeD = makeNode('d')
        const nodeE = makeNode('e')
        const nodeF = makeNode('f')
        const nodeG = makeNode('g')
        const nodeH = makeNode('h')

        const lockCD = creator.makeLinkLock('c', 'd', true)
        const lockDE = creator.makeLinkLock('d', 'e', true)
        const lockEF = creator.makeLinkLock('e', 'f', true)

        // one way approaches and exits
        graph.addLink('a', 'c', creator.makeLinkLock('a', 'c'))
        graph.addLink('c', 'b', creator.makeLinkLock('c', 'b'))
        graph.addLink('h', 'f', creator.makeLinkLock('h', 'f'))
        graph.addLink('f', 'g', creator.makeLinkLock('f', 'g'))

        // the corridor itself
        graph.addLink('c', 'd', lockCD)
        graph.addLink('d', 'c', lockCD)
        graph.addLink('d', 'e', lockDE)
        graph.addLink('e', 'd', lockDE)
        graph.addLink('e', 'f', lockEF)
        graph.addLink('f', 'e', lockEF)

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const pathSWtoNE = pathFinder.find('a', 'g').reverse() // a c d e f g
        const pathSEtoNW = pathFinder.find('h', 'b').reverse() // h f e d c b
        expect(pathSWtoNE.map(n => n.id)).toEqual(['a', 'c', 'd', 'e', 'f', 'g'])
        expect(pathSEtoNW.map(n => n.id)).toEqual(['h', 'f', 'e', 'd', 'c', 'b'])

        const makeLocker = creator.makeMakeLocker(node => node.data, getLockForLink)
        let granted1: Array<NextNode> = []
        let granted2: Array<NextNode> = []
        const agent1 = makeLocker('agent1').makePathLocker(pathSWtoNE)(
            nn => { granted1 = nn })
        const agent2 = makeLocker('agent2').makePathLocker(pathSEtoNW)(
            nn => { granted2 = nn })

        // agent1 claims the whole run through to its exit, because the
        // corridor is bidirectional and only a one way edge is safe to stop on
        agent1.arrivedAt(0)
        expect(granted1.map(n => n.node)).toEqual(['a', 'c'])
        expect(lockEF.isLocked()).toBeTruthy()

        // agent2 may enter at H but is refused the corridor: agent1 already
        // reserved it end to end, and turning back inside is impossible
        agent2.arrivedAt(0)
        expect(granted2.map(n => n.node)).toEqual(['h'])
        expect(nodeF.data.isLocked('agent2')).toBeFalsy()

        // agent1 runs the corridor to its exit, releasing behind itself
        for (const id of ['c', 'd', 'e', 'f', 'g']) {
            agent1.arrivedAt(pathSWtoNE.findIndex(n => n.id === id))
        }
        expect(granted1.map(n => n.node)).toEqual(['g'])
        expect(nodeG.data.isLocked('agent1')).toBeTruthy()

        // the corridor is free, so agent2 is granted the whole way through
        // to B without either of them ever meeting inside
        agent2.arrivedAt(0)
        expect(granted2.map(n => n.node)).toEqual(['h', 'f'])
        for (const id of ['f', 'e', 'd', 'c', 'b']) {
            agent2.arrivedAt(pathSEtoNW.findIndex(n => n.id === id))
        }
        expect(granted2.map(n => n.node)).toEqual(['b'])
        expect(nodeB.data.isLocked('agent2')).toBeTruthy()

        // they swapped sides; neither is on the other's half of the map
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeH.data.isLocked()).toBeFalsy()
        expect(nodeG.data.isLocked('agent1')).toBeTruthy()
        expect(nodeB.data.isLocked('agent2')).toBeTruthy()
    })

    test('bidirectional corridor convoy', () => {
        const graph = ngraphCreateGraph<Lock, LinkLock>()
        const creator = new Graferse<Node<Lock>>(x => x.id)

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
        let s1calls = 0
        let s2calls = 0
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
        expect(linkCD.data.isLocked()).toBeTruthy()
        expect(linkDE.data.isLocked()).toBeTruthy()
        expect(linkEF.data.isLocked()).toBeTruthy()
        expect(linkFG.data.isLocked()).toBeTruthy()

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
        const creator = new Graferse<Node<Lock>>(node => node.id)

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
        let s1ForwardPath: Array<NextNode> = []
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
        let s2ForwardPath: Array<NextNode> = []
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
        expect(linkCB.data.isLocked("agent1")).toBeTruthy()
        expect(linkBA.data.isLocked("agent1")).toBeTruthy()
        expect(linkCE.data.isLocked()).toBeFalsy()

        // lets continue down the hallway
        s1LockNext.arrivedAt(s1Path.indexOf(nodeB))
        expect(s1ForwardPath).toEqual([{index: 1, node: 'b'}, {index: 2, node: 'c'}])
        expect(s2ForwardPath).toEqual([])

        s1LockNext.arrivedAt(s1Path.indexOf(nodeC))
        expect(s1ForwardPath).toEqual([{index: 2, node: 'c'}, {index: 3, node: 'e'}])
        expect(s2ForwardPath).toEqual([])

        s1LockNext.arrivedAt(s1Path.indexOf(nodeE))
        expect(s1ForwardPath).toEqual([{index: 3, node: 'e'}])
        // agent2 obtains nodeD and C after stepping off bidir lane
        expect(s2ForwardPath).toEqual([{index: 0, node: 'd'}, {index: 1, node: 'c'}])
    })

    test('three agents bidirectional corridor with early exit', () => {
        const graph = ngraphCreateGraph<Lock, LinkLock>()
        const creator = new Graferse<Node<Lock>>(node => node.id)

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
        let s1ForwardPath: Array<NextNode> = []
        const s1LockNext = makeLocker("agent1").makePathLocker(s1Path)((nextNodes) => { s1ForwardPath = nextNodes })

        expect(s1ForwardPath).toEqual([])

        s1LockNext.arrivedAt(s1Path.indexOf(nodeA))
        // its current and next nodes are locked
        expect(s1ForwardPath).toEqual([{index: 0, node: 'a'}, {index: 1, node: 'b'}])

        // an opposing robot appears
        const s2Path = pathFinder.find('d', 'a').reverse()
        let s2ForwardPath: Array<NextNode> = []
        const s2LockNext = makeLocker("agent2").makePathLocker(s2Path)((nextNodes) => { s2ForwardPath = nextNodes })
        //console.log({s2Path})
        s2LockNext.arrivedAt(s2Path.indexOf(nodeD))

        // but fails to get a lock on the c -> d link because its locked in the opposite direction
        expect(s2ForwardPath).toEqual([{index: 0, node: 'd'}])

        s1LockNext.arrivedAt(s1Path.indexOf(nodeB))
        expect(s1ForwardPath).toEqual([{index: 1, node: 'b'}, {index: 2, node: 'c'}])
        expect(s2ForwardPath).toEqual([{index: 0, node: 'd'}])

        const s3Path = pathFinder.find('a', 'f').reverse()
        let s3ForwardPath: Array<NextNode> = []
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
    test('two robots opposing directions never adjacent nodes', () => {
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
        const creator = new Graferse<Node<Lock>>(node => node.id)

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

        graph.addLink('a', 'b', creator.makeLinkLock('a', 'b'))
        graph.addLink('b', 'c', creator.makeLinkLock('b', 'c'))
        addBiLink('c', 'd', lockCD)
        addBiLink('d', 'e', lockDE)
        graph.addLink('g', 'f', creator.makeLinkLock('g', 'f'))
        graph.addLink('f', 'e', creator.makeLinkLock('f', 'e'))
        addBiLink('c', 'y', lockCY)
        addBiLink('e', 'z', lockEZ)

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const path1 = pathFinder.find('a', 'z').reverse()
        const path2 = pathFinder.find('g', 'y').reverse()

        const makeLocker = creator.makeMakeLocker(node => node.data, getLockForLink)
        let nextNodes1: Array<NextNode> = []
        let nextNodes2: Array<NextNode> = []
        const agent1at = arriveByNodeId(
            makeLocker("agent1").makePathLocker(path1)((nn) => { nextNodes1 = nn }).arrivedAt, path1)
        const agent2at = arriveByNodeId(
            makeLocker("agent2").makePathLocker(path2)((nn) => { nextNodes2 = nn }).arrivedAt, path2)

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
    test('two robots opposing directions never adjacent nodes - part2', () => {
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
        const creator = new Graferse<Node<Lock>>(node => node.id)

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

        graph.addLink('a', 'b', creator.makeLinkLock('a', 'b'))
        graph.addLink('b', 'c', creator.makeLinkLock('b', 'c'))
        addBiLink('c', 'd', lockCD)
        addBiLink('d', 'e', lockDE)
        graph.addLink('g', 'f', creator.makeLinkLock('g', 'f'))
        addBiLink('f', 'e', lockEF)
        addBiLink('c', 'y', lockCY)
        addBiLink('e', 'z', lockEZ)

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const path1 = pathFinder.find('a', 'z').reverse()
        const path2 = pathFinder.find('g', 'y').reverse()

        const makeLocker = creator.makeMakeLocker(node => node.data, getLockForLink)
        let nextNodes1: Array<NextNode> = []
        let nextNodes2: Array<NextNode> = []
        const agent1at = arriveByNodeId(
            makeLocker("agent1").makePathLocker(path1)((nn) => { nextNodes1 = nn }).arrivedAt, path1)
        const agent2at = arriveByNodeId(
            makeLocker("agent2").makePathLocker(path2)((nn) => { nextNodes2 = nn }).arrivedAt, path2)

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
        expect(nextNodes2).toEqual([{index: 0, node: 'g'}])

        agent1at('z')
        expect(nextNodes1).toEqual([{index: 5, node: 'z'}])
        expect(nextNodes2).toEqual([{index: 0, node: 'g'}, {index: 1, node: 'f'}]) // now we can move to F
        agent2at('f')
        expect(nextNodes1).toEqual([{index: 5, node: 'z'}])
        expect(nextNodes2).toEqual([{index: 1, node: 'f'}, {index: 2, node: 'e'}])

        agent2at('e')
        expect(nextNodes1).toEqual([{index: 5, node: 'z'}])
        expect(nextNodes2).toEqual([{index: 2, node: 'e'}, {index: 3, node: 'd'}])
    })
    // A ring with every edge bidirectional and NO exit anywhere: there is no
    // one way edge to stop at, so reserving "to a safe stop" means reserving
    // the whole lap.  A lap always contains the leader, so without the convoy
    // rule no second robot could ever set a wheel on the ring.
    const makeRing = () => {
        const graph = ngraphCreateGraph<Lock, LinkLock>()
        const creator = new Graferse<Node<Lock>>(node => node.id)
        const makeNode = (id: string) => graph.addNode(id, creator.makeLock(id))
        const ring = ['w', 'nw', 'ne', 'e', 'se', 'sw']
        const nodes = new Map(ring.map(id => [id, makeNode(id)]))
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length]
            const lock = creator.makeLinkLock(a, b, true)
            graph.addLink(a, b, lock)
            graph.addLink(b, a, lock)
        }
        // where a robot waits before joining, reached by a one way edge, as a
        // parking spot is
        const mkStart = (id: string, onto: string) => {
            const node = graph.addNode(id, creator.makeLock(id))
            graph.addLink(id, onto, creator.makeLinkLock(id, onto))
            nodes.set(id, node)
            return node
        }
        const at = (id: string) => nodes.get(id)!
        // a full lap of the ring, ending back where it started - on the ring
        const lap = (from: string) => {
            const i = ring.indexOf(from)
            return [...ring.slice(i), ...ring.slice(0, i), ring[i]].map(at)
        }
        return { creator, ring, at, mkStart, lap }
    }

    test('fully bidirectional ring: a follower joins behind the leader', () => {
        const { creator, at, mkStart, lap } = makeRing()
        const start2 = mkStart('start2', 'e')

        const makeLocker = creator.makeMakeLocker(node => node.data, getLockForLink)
        let nextNodes1: Array<NextNode> = []
        let nextNodes2: Array<NextNode> = []
        const leader = makeLocker("leader").makePathLocker(lap('w'))((nn) => { nextNodes1 = nn })
        const follower = makeLocker("follower").makePathLocker([start2, ...lap('e')])((nn) => { nextNodes2 = nn })

        leader.arrivedAt(0)
        expect(nextNodes1).toEqual([{index: 0, node: 'w'}, {index: 1, node: 'nw'}])

        // The follower's lap runs the whole ring, so it always contains the
        // leader.  It joins anyway: the leader is travelling its way, so the
        // two are one longer vehicle and leave by the exit the leader holds.
        follower.arrivedAt(0)
        expect(nextNodes2).toEqual([{index: 0, node: 'start2'}, {index: 1, node: 'e'}])
        expect(at('e').data.isLocked("follower")).toBeTruthy()

        // It stops on entry rather than claiming past the leader.
        expect(at('se').data.isLocked("follower")).toBeFalsy()
        expect(at('nw').data.isLocked("follower")).toBeFalsy()

        // And it trails the leader round, one node at a time.
        follower.arrivedAt(1)
        expect(nextNodes2).toEqual([{index: 1, node: 'e'}, {index: 2, node: 'se'}])
        follower.arrivedAt(2)
        expect(nextNodes2).toEqual([{index: 2, node: 'se'}, {index: 3, node: 'sw'}])
    })

    test('fully bidirectional ring: no joining behind a robot that is not leading', () => {
        const { creator, at, mkStart, lap } = makeRing()
        const start2 = mkStart('start2', 'e')
        // an idle robot squatting on the ring: it claims no direction, so it
        // owes us no exit and cannot be followed
        at('nw').data.requestLock("idler", "nw")

        const makeLocker = creator.makeMakeLocker(node => node.data, getLockForLink)
        let nextNodes2: Array<NextNode> = []
        const follower = makeLocker("follower").makePathLocker([start2, ...lap('e')])((nn) => { nextNodes2 = nn })

        follower.arrivedAt(0)
        expect(nextNodes2).toEqual([{index: 0, node: 'start2'}])
        expect(at('e').data.isLocked("follower")).toBeFalsy()
    })

    test('fully bidirectional ring: no joining against the leader', () => {
        const { creator, at, mkStart, lap } = makeRing()
        const start2 = mkStart('start2', 'e')

        const makeLocker = creator.makeMakeLocker(node => node.data, getLockForLink)
        let nextNodes2: Array<NextNode> = []
        const leader = makeLocker("leader").makePathLocker(lap('w'))(() => {})
        // the opposite way round the ring from the leader
        const against = [...lap('e')].reverse()
        const follower = makeLocker("follower").makePathLocker([start2, ...against])((nn) => { nextNodes2 = nn })

        leader.arrivedAt(0)
        follower.arrivedAt(0)
        expect(nextNodes2).toEqual([{index: 0, node: 'start2'}])
        expect(at('e').data.isLocked("follower")).toBeFalsy()
    })

    test('directed', () => {
        const graph = ngraphCreateGraph()
        const creator = new Graferse<Node<Lock>>(node => node.id)

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

        for (let i = 0; i < path.length; i++) {
            lockNext.arrivedAt(i)
        }
    })
    test('agent encountered on bidir path with reversal', () => {
        const graph = ngraphCreateGraph<Lock, LinkLock>()
        const creator = new Graferse<Node<Lock>>(node => node.id)

        const makeNode = (id: string) => graph.addNode(id, creator.makeLock(id))
        const nodeA = makeNode('a')
        const nodeB = makeNode('b')
        const nodeC = makeNode('c')
        const nodeD = makeNode('d')

        // A ----> B <----> C
        //         |
        //         v 
        //         D

        const lockAB = creator.makeLinkLock('a', 'b', false)
        const lockBC = creator.makeLinkLock('b', 'c', true)
        const lockCD = creator.makeLinkLock('b', 'd', false)

        const linkAB = graph.addLink('a', 'b', lockAB)
        const linkBC = graph.addLink('b', 'c', lockBC)
        const linkBD = graph.addLink('b', 'd', lockCD)

        const linkDB = graph.addLink('d', 'b', lockCD)
        const linkCB = graph.addLink('c', 'b', lockBC)
        const linkBA = graph.addLink('b', 'a', lockAB)

        const s1Path = [nodeA, nodeB, nodeC, nodeB, nodeD]

        const makeLocker = creator.makeMakeLocker(node => node.data, getLockForLink)
        let s1ForwardPath: Array<NextNode> = []
        const s1LockNext = makeLocker("agent1").makePathLocker(s1Path)((nextNodes) => { s1ForwardPath = nextNodes })

        //console.dir({nodeC}, {depth: null})
        expect(nodeC.data.requestLock('agent2', 'static')).toBeTruthy()
        // all nodes are unlocked
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeTruthy() // locked by static agent2
        expect(nodeD.data.isLocked()).toBeFalsy()
        // all links are unlocked
        expect(linkAB.data.isLocked()).toBeFalsy()
        expect(linkBC.data.isLocked()).toBeFalsy()
        expect(linkBD.data.isLocked()).toBeFalsy()
        expect(linkDB.data.isLocked()).toBeFalsy()
        expect(linkCB.data.isLocked()).toBeFalsy()
        expect(linkBA.data.isLocked()).toBeFalsy()

        expect(s1ForwardPath).toEqual([])

        s1LockNext.arrivedAt(s1Path.indexOf(nodeA))
        // its current and next nodes are locked
        // nodeB omitted because agent encountered on bidir path
        expect(s1ForwardPath).toEqual([{index: 0, node: 'a'}/*, {index: 1, node: 'b'}*/])
        expect(nodeA.data.isLocked()).toBeTruthy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeTruthy() // still locked by agent2
        expect(nodeD.data.isLocked()).toBeFalsy()

        // all links are locked until path ends
        expect(linkAB.data.isLocked()).toBeFalsy() // its oneway, never locked
        expect(linkBC.data.isLocked()).toBeFalsy()
        expect(linkBD.data.isLocked()).toBeFalsy()
        expect(linkDB.data.isLocked()).toBeFalsy()
        expect(linkCB.data.isLocked()).toBeFalsy()
        expect(linkBA.data.isLocked()).toBeFalsy() // its oneway, never locked
    })
})

describe('Components', () => {
    describe('Lock', () => {
        test('locking twice', () => {
            const creator = new Graferse<Node>(node => node.id)
            const lock = creator.makeLock('lock')
            expect(lock.requestLock('test', 'abc')).toBeTruthy()
            expect(lock.requestLock('test', 'def')).toBeTruthy()
        })

        // isLockedByOtherThan is true whenever several holders share a lock,
        // even when byWhom is one of them.  The group availability check used
        // to treat the subsequent requestLock succeeding as a contradiction
        // and threw - mid arrivedAt, after other locks were already taken.
        test('a group member already shared by the caller is available', () => {
            const creator = new Graferse<string>(x => x)
            const nodeA = creator.makeLock('a')
            const nodeB = creator.makeLock('b')
            creator.setLockGroup([nodeA, nodeB])

            // forceLock does not arbitrate; two names on one lock is the
            // state isLockedByOtherThan reports as "held by someone else"
            nodeA.forceLock('agent1')
            nodeA.forceLock('agent2')

            expect(nodeA.isLockedByOtherThan('agent1')).toBeTruthy()
            expect(() => creator.isLockGroupAvailable(nodeB, 'agent1'))
                .not.toThrow()
            // agent1 already holds the blocking member, so the group is theirs
            expect(creator.isLockGroupAvailable(nodeB, 'agent1')).toBe(true)
            // agent3 is still shut out of the group
            expect(creator.isLockGroupAvailable(nodeB, 'agent3')).toBe(false)
        })

        test('one agent may only hold one path locker at a time', () => {
            const creator = new Graferse<string>(x => x)
            const locks = new Map(
                ['a', 'b', 'c', 'd'].map(id => [id, creator.makeLock(id)]))
            const ab = creator.makeLinkLock('a', 'b', true)
            const bc = creator.makeLinkLock('b', 'c', true)
            const cd = creator.makeLinkLock('c', 'd', true)
            const links = new Map([
                ['a>b', ab], ['b>a', ab],
                ['b>c', bc], ['c>b', bc],
                ['c>d', cd], ['d>c', cd],
            ])
            const makeLocker = creator.makeMakeLocker(
                (x: string) => locks.get(x)!,
                (from: string, to: string) => links.get(`${from}>${to}`)!,
            )

            const locker = makeLocker('agent1')
            locker.makePathLocker(['a', 'b'])(() => {})
            // same agent, second path: lastCallCache is keyed by agent id, so
            // the first path's replay closure would be overwritten
            expect(() => locker.makePathLocker(['a', 'c'])(() => {}))
                .toThrow(/already has a path locker/)

            // a different agent is unaffected
            makeLocker('agent2').makePathLocker(['a', 'b'])(() => {})

            // clearing frees the id for a fresh path
            locker.clearAllLocks()
            expect(() => locker.makePathLocker(['a', 'c'])(() => {}))
                .not.toThrow()
        })

        test('an idle hold ends the path, so the agent can start its next one', () => {
            // clearAllExceptLastPathLocks is how an agent parks on the graph
            // between tours.  It ends the path: the agent keeps only the node
            // it sits on, and waits nowhere, so there is nothing to replay.
            const creator = new Graferse<string>(x => x)
            const locks = new Map(
                ['a', 'b', 'c'].map(id => [id, creator.makeLock(id)]))
            const ab = creator.makeLinkLock('a', 'b', true)
            const bc = creator.makeLinkLock('b', 'c', true)
            const links = new Map([
                ['a>b', ab], ['b>a', ab],
                ['b>c', bc], ['c>b', bc],
            ])
            const locker = creator.makeMakeLocker(
                (x: string) => locks.get(x)!,
                (from: string, to: string) => links.get(`${from}>${to}`)!,
            )('agent1')

            const tour = locker.makePathLocker(['a', 'b'])(() => {})
            tour.arrivedAt(0)
            tour.arrivedAt(1)
            tour.clearAllExceptLastPathLocks()
            expect(locks.get('b')!.isLocked('agent1')).toBeTruthy()
            expect(creator.lastCallCache.has('agent1')).toBeFalsy()

            expect(() => locker.makePathLocker(['b', 'c'])(() => {}).arrivedAt(0))
                .not.toThrow()
        })

        describe('a new path takes over the idle hold', () => {
            // agent1 idles on b after its first tour.  Its next tour starts
            // from s, off b's links, so the path never passes b and would
            // never release it on its own.
            const setup = () => {
                const creator = new Graferse<string>(x => x)
                const locks = new Map(
                    ['a', 'b', 's', 'c'].map(id => [id, creator.makeLock(id)]))
                const ab = creator.makeLinkLock('a', 'b')
                const sc = creator.makeLinkLock('s', 'c')
                const links = new Map([['a>b', ab], ['s>c', sc]])
                const makeLocker = creator.makeMakeLocker(
                    (x: string) => locks.get(x)!,
                    (from: string, to: string) => links.get(`${from}>${to}`)!,
                )
                const agent1 = makeLocker('agent1')
                const first = agent1.makePathLocker(['a', 'b'])(() => {})
                first.arrivedAt(0)
                first.arrivedAt(1)
                first.clearAllExceptLastPathLocks()

                // agent2 queues up behind the idle agent1
                let agent2Granted: string[] = []
                makeLocker('agent2').makePathLocker(['a', 'b'])(
                    (next: NextNode[]) => { agent2Granted = next.map(n => n.node) },
                ).arrivedAt(0)
                expect(agent2Granted).toEqual(['a'])
                return { locks, agent1, agent2Granted: () => agent2Granted }
            }

            test('released once the agent drives off its start, waking the waiter', () => {
                const { locks, agent1, agent2Granted } = setup()
                const second = agent1.makePathLocker(['s', 'c'])(() => {})
                second.arrivedAt(0)
                // still standing on b
                expect(locks.get('b')!.isLocked('agent1')).toBeTruthy()
                second.arrivedAt(1)
                expect(locks.get('b')!.isLocked('agent1')).toBeFalsy()
                expect(agent2Granted()).toEqual(['a', 'b'])
            })

            test('released when the new path is dropped entirely', () => {
                const { locks, agent1, agent2Granted } = setup()
                const second = agent1.makePathLocker(['s', 'c'])(() => {})
                second.arrivedAt(0)
                second.clearAllPathLocks()
                expect(locks.get('b')!.isLocked('agent1')).toBeFalsy()
                expect(agent2Granted()).toEqual(['a', 'b'])
            })

            test('kept by an idle hold before the agent moved, for the path after', () => {
                const { locks, agent1, agent2Granted } = setup()
                const second = agent1.makePathLocker(['s', 'c'])(() => {})
                second.arrivedAt(0)
                second.clearAllExceptLastPathLocks()
                // never left b
                expect(locks.get('b')!.isLocked('agent1')).toBeTruthy()

                const third = agent1.makePathLocker(['s', 'c'])(() => {})
                third.arrivedAt(0)
                third.arrivedAt(1)
                expect(locks.get('b')!.isLocked('agent1')).toBeFalsy()
                expect(agent2Granted()).toEqual(['a', 'b'])
            })
        })
    })

    describe('LinkLock', () => {
        test('locking when directed edge', () => {
            const logSpyWarn = jest.spyOn(console, 'warn').mockImplementation()
            const logSpyError = jest.spyOn(console, 'error').mockImplementation()
            const creator = new Graferse<Node>(node => node.id)
            const linkLock = creator.makeLinkLock('up', 'down') // by default is directed edge
            // a one way edge has no opposing direction to contend over, so the
            // request always succeeds, and says nothing about it
            expect(linkLock.requestLock('test', 'up')).toBeTruthy()
            expect(linkLock.requestLock('test', 'down')).toBeTruthy()
            expect(logSpyWarn).not.toHaveBeenCalled()
            expect(logSpyError).not.toHaveBeenCalled()

            jest.resetAllMocks()
        })

        describe('Locking in both directions', () => {
            test('single owner can lock both directions', () => {
                const creator = new Graferse<Node>(node => node.id)
                const linkLock = creator.makeLinkLock('up', 'down', true) // is bidirectional
                expect(linkLock.requestLock('agent1', 'up')).toBeTruthy()
                expect(linkLock.requestLock('agent1', 'down')).toBeTruthy()
            })
            test('owner cannot lock both directions if multiple owners', () => {
                const creator = new Graferse<Node>(node => node.id)
                const linkLock = creator.makeLinkLock('up', 'down', true) // is bidirectional
                expect(linkLock.requestLock('agent1', 'up')).toBeTruthy()
                expect(linkLock.requestLock('agent2', 'up')).toBeTruthy()
                expect(linkLock.requestLock('agent1', 'down')).toBeFalsy()
                expect(linkLock.isWaiting('agent1')).toBeTruthy()
            })
            test('agent cannot lock if both directions already locked', () => {
                const creator = new Graferse<Node>(node => node.id)
                const linkLock = creator.makeLinkLock('up', 'down', true) // is bidirectional
                expect(linkLock.requestLock('agent1', 'up')).toBeTruthy()
                expect(linkLock.requestLock('agent1', 'down')).toBeTruthy()
                expect(linkLock.requestLock('agent2', 'up')).toBeFalsy()
                expect(linkLock.isWaiting('agent2')).toBeTruthy()

                expect(linkLock.unlock('agent1', 'up')).toEqual(new Set())
                expect(linkLock.requestLock('agent2', 'up')).toBeFalsy()
                expect(linkLock.isWaiting('agent2')).toBeTruthy()

                expect(linkLock.requestLock('agent1', 'up')).toBeTruthy()
                expect(linkLock.unlock('agent1', 'down')).toEqual(new Set(["agent2"]))
                expect(linkLock.requestLock('agent2', 'up')).toBeTruthy()
                expect(linkLock.isWaiting('agent2')).toBeFalsy()
            })
        })

        test('getDetails is a snapshot, not a window into the lock', () => {
            const creator = new Graferse<Node>(node => node.id)
            const linkLock = creator.makeLinkLock('up', 'down', true)
            expect(linkLock.requestLock('agent1', 'up')).toBeTruthy()

            const details = linkLock.getDetails()
            expect(details.lockers.get('up')).toEqual(new Set(['agent1']))

            // mutating what we were handed must not change who holds the link
            details.lockers.get('up')!.clear()
            details.lockers.set('down', new Set(['intruder']))
            details.waiters.get('up')!.add('intruder')

            expect(linkLock.isLocked('agent1')).toBeTruthy()
            expect(linkLock.isLocked('intruder')).toBeFalsy()
            expect(linkLock.isWaiting('intruder')).toBeFalsy()
            expect(linkLock.getDetails().lockers.get('up'))
                .toEqual(new Set(['agent1']))
            expect(linkLock.getDetails().lockers.get('down'))
                .toEqual(new Set())
        })
    })
})

describe('Listeners', () => {
    test('smoke', () => {
        let listenCallbackCounter = 0
        const creator = new Graferse<Node>(node => node.id)
        creator.addListener(() => { listenCallbackCounter++ })

        // no one has been called yet
        expect(listenCallbackCounter).toEqual(0)

        // clearAllLocks invokes listeners
        creator.clearAllLocks("test")
        expect(listenCallbackCounter).toEqual(1)

        // notifyWaiters invokes listeners
        creator.notifyWaiters(new Set())
        expect(listenCallbackCounter).toEqual(2)

        // nested notifyWaiters only enqueues; listeners fire once when the
        // whole cascade drains, not once per hop
        creator.lastCallCache.set("agent1", () => creator.notifyWaiters(new Set()))
        creator.notifyWaiters(new Set(["agent1"]))
        expect(listenCallbackCounter).toEqual(3)
    })
})

describe('notifyWaiters cascade', () => {
    test('runs depth-first: A, A\'s cascade, then B', () => {
        const order: string[] = []
        const creator = new Graferse<string>(x => x)
        creator.lastCallCache.set('A', () => {
            order.push('A')
            creator.notifyWaiters(new Set(['C', 'D']))
        })
        creator.lastCallCache.set('C', () => { order.push('C') })
        creator.lastCallCache.set('D', () => { order.push('D') })
        creator.lastCallCache.set('B', () => { order.push('B') })

        creator.notifyWaiters(new Set(['A', 'B']))
        expect(order).toEqual(['A', 'C', 'D', 'B'])
    })

    test('a long freed chain does not recurse into the stack', () => {
        const creator = new Graferse<string>(x => x)
        const length = 5000
        for (let i = 0; i < length - 1; i++) {
            creator.lastCallCache.set(`a${i}`, () => {
                creator.notifyWaiters(new Set([`a${i + 1}`]))
            })
        }
        creator.lastCallCache.set(`a${length - 1}`, () => {
            creator.notifyWaiters(new Set())
        })

        // the old recursive notifyWaiters grew one stack frame per agent and
        // would overflow well before 5000
        expect(() => creator.notifyWaiters(new Set(['a0']))).not.toThrow()
    })
})

describe('Exceptions', () => {
    test('arrivedAt bounds', () => {
        const getLockForLink = (from: Lock, to: Lock) =>
            requireLinkLock(creator, (x: Lock) => x, from, to)
        const creator = new Graferse<Lock>(node => node?.id)
        const nodeA = creator.makeLock('nodeA')
        const nodeB = creator.makeLock('nodeB')
        const nodeC = creator.makeLock('nodeC')
        const nodeX = creator.makeLock('nodeX')

        creator.makeLinkLock('nodeA', 'nodeB')
        creator.makeLinkLock('nodeB', 'nodeC')

        const makeLocker = creator.makeMakeLocker(
            node => node,
            (from, to) => requireLinkLock(creator, (x: Lock) => x, from, to))

        const test1Path = [nodeA, nodeB, nodeC]
        let forwardPath: Array<NextNode> = []
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
