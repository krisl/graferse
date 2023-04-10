import type { Node } from 'ngraph.graph'
import ngraphCreateGraph from 'ngraph.graph'
import ngraphPath from 'ngraph.path'
import { Lock, makeMakeLocker } from './graph.js'

describe('ngraph', () => {
    test('basic locking', () => {
        const graph = ngraphCreateGraph()

        const nodeA = graph.addNode('a', new Lock())
        const nodeB = graph.addNode('b', new Lock())
        const nodeC = graph.addNode('c', new Lock())

        graph.addLink('a', 'b')
        graph.addLink('b', 'c')

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const path = pathFinder.find('a', 'c').reverse()

        const makeLocker = makeMakeLocker<Node<Lock>>(node => node.data)
        const lockNext = makeLocker("agent1", path, (nextNodes) => {})

        // all nodes are unlocked
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeFalsy()

        // progressing to the first node locks it, and the next
        lockNext(nodeA)
        expect(nodeA.data.isLocked()).toBeTruthy()
        expect(nodeB.data.isLocked()).toBeTruthy()
        expect(nodeC.data.isLocked()).toBeFalsy()

        // progressing to the second node locks it, and the next
        // and unlocks nodes behind it
        lockNext(nodeB)
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeTruthy()
        expect(nodeC.data.isLocked()).toBeTruthy()

        // progressing to the last node locks it
        // and unlocks nodes behind it
        lockNext(nodeC)
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeTruthy()

    })

    test('unexpected queue jumping', () => {
        const graph = ngraphCreateGraph()

        const nodeA = graph.addNode('a', new Lock())
        const nodeB = graph.addNode('b', new Lock())
        const nodeC = graph.addNode('c', new Lock())

        graph.addLink('a', 'b')
        graph.addLink('b', 'c')

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const path = pathFinder.find('a', 'c').reverse()

        const makeLocker = makeMakeLocker<Node<Lock>>(node => node.data)
        const lockNext = makeLocker("agent1", path, (nextNodes) => {})

        // manually lock all nodes
        nodeA.data.requestLock("agent1")
        nodeB.data.requestLock("agent1")
        nodeC.data.requestLock("agent1")

        expect(nodeA.data.isLocked()).toBeTruthy()
        expect(nodeB.data.isLocked()).toBeTruthy()
        expect(nodeC.data.isLocked()).toBeTruthy()

        // suddenly appearing at the last node locks it
        // and unlocks nodes behind it
        lockNext(nodeC)
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeTruthy()
    })

    test('directed', () => {
        const graph = ngraphCreateGraph()

        graph.addNode('a', new Lock())
        graph.addNode('b', new Lock())
        graph.addNode('c', new Lock())
        graph.addLink('a', 'b')
        graph.addLink('b', 'c')
        graph.addLink('c', 'b')
        graph.addLink('b', 'a')

        graph.forEachLinkedNode(
            'b',
            function(node, link) { console.dir({node, link}) },
            false
        )

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const path = pathFinder.find('a', 'c').reverse()

        console.dir(path)
        const makeLocker = makeMakeLocker<Node<Lock>>(node => node.data)
        const lockNext = makeLocker("agent1", path, (nextNodes) => console.log("step", {nextNodes}))

        for (var i = 0; i < path.length; i++) {
            console.log("====== step =======")
            lockNext(path[i])
        }
    })
})
