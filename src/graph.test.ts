import type { Node } from 'ngraph.graph'
import ngraphCreateGraph from 'ngraph.graph'
import ngraphPath from 'ngraph.path'
import { Lock, makeMakeLocker } from './graph.js'

describe('ngraph', () => {
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
        const lockNext = makeLocker("agent1")

        for (var i = 0; i < 4; i++) {
            console.log("====== step =======")
            lockNext(path)
            console.dir(path)
        }
    })
})
