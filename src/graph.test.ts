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

        var forwardPath: Array<Node<Lock>> = []
        const makeLocker = makeMakeLocker<Node<Lock>>(node => node.data)
        const lockNext = makeLocker("agent1", path, (nextNodes) => { forwardPath = nextNodes })

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

        graph.addLink('a', 'b')
        graph.addLink('b', 'c')

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const path = pathFinder.find('a', 'c').reverse()

        var forwardPath: Array<Node<Lock>> = []
        const makeLocker = makeMakeLocker<Node<Lock>>(node => node.data)
        const lockNext = makeLocker("agent1", path, (nextNodes) => { forwardPath = nextNodes })

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

        graph.addLink('a', 'c')
        graph.addLink('b', 'c')

        const pathFinder = ngraphPath.aStar(graph, { oriented: true })
        const s1Path = pathFinder.find('a', 'c').reverse()
        const s2Path = pathFinder.find('b', 'c').reverse()

        var s1ForwardPath: Array<Node<Lock>> = []
        var s2ForwardPath: Array<Node<Lock>> = []
        const makeLocker = makeMakeLocker<Node<Lock>>(node => node.data)
        const s1LockNext = makeLocker("agent1", s1Path, (nextNodes) => { s1ForwardPath = nextNodes })
        const s2LockNext = makeLocker("agent2", s2Path, (nextNodes) => { s2ForwardPath = nextNodes })

        // all nodes are unlocked
        expect(nodeA.data.isLocked()).toBeFalsy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeFalsy()
        expect(s1ForwardPath).toEqual([])
        expect(s2ForwardPath).toEqual([])

        // moving agent1 to the first node locks it, and the next
        s1LockNext(nodeA)
        expect(nodeA.data.isLocked()).toBeTruthy()
        expect(nodeB.data.isLocked()).toBeFalsy()
        expect(nodeC.data.isLocked()).toBeTruthy()
        expect(s1ForwardPath).toEqual([nodeA, nodeC])
        expect(s2ForwardPath).toEqual([])

        // moving agent1 to its first node locks it
        // but the second is common to both paths, and already locked
        s2LockNext(nodeB)
        expect(nodeA.data.isLocked()).toBeTruthy()
        expect(nodeB.data.isLocked()).toBeTruthy()
        expect(nodeC.data.isLocked()).toBeTruthy()
        expect(s1ForwardPath).toEqual([nodeA, nodeC])
        expect(s2ForwardPath).toEqual([nodeB])  // nodeC missing because locked by agent1
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
