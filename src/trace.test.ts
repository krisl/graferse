import makeDebug from 'debug'
import { makeTrace, traceDepth, resetTraceDepth } from './trace.js'
import { Graferse } from './graph.js'

// the renderer is chosen at import time; under jest there is no window, so
// these exercise the terminal path.  What matters either way is the depth
// bookkeeping, which an unbalanced frame would corrupt for every later trace.
describe('trace', () => {
    beforeEach(() => {
        resetTraceDepth()
        makeDebug.enable('trace-test')
    })
    afterEach(() => makeDebug.disable())

    test('balanced frames return to the top level', () => {
        const trace = makeTrace('trace-test')
        expect(traceDepth()).toBe(0)
        trace.open('outer')
        expect(traceDepth()).toBe(1)
        trace.open('inner')
        expect(traceDepth()).toBe(2)
        trace.close()
        trace.close()
        expect(traceDepth()).toBe(0)
    })

    test('a throw inside a frame still closes it', () => {
        const trace = makeTrace('trace-test')
        const boom = () => {
            trace.open('outer')
            try {
                throw new Error('boom')
            } finally {
                trace.close()
            }
        }
        expect(boom).toThrow('boom')
        expect(traceDepth()).toBe(0)
    })

    test('closing more than we opened never goes negative', () => {
        const trace = makeTrace('trace-test')
        trace.close()
        trace.close()
        expect(traceDepth()).toBe(0)
        // and the next frame still starts at the top level
        trace.open('outer')
        expect(traceDepth()).toBe(1)
        trace.close()
        expect(traceDepth()).toBe(0)
    })

    test('a disabled namespace records no depth', () => {
        const trace = makeTrace('trace-off')
        expect(trace.enabled).toBe(false)
        trace.open('outer')
        expect(traceDepth()).toBe(0)
        trace.close()
        expect(traceDepth()).toBe(0)
    })
})

// The `graferse` namespace is the one line per move that you read by default;
// `graferse:walk` is the tree underneath it.
describe('summary namespace', () => {
    const lines: string[] = []
    const original = makeDebug.log
    // debug prepends its own timestamp and namespace; the content is ours
    const said = () => lines.map(l => l.replace(/^\S+ graferse(:walk)? /, ''))

    beforeEach(() => {
        resetTraceDepth()
        lines.length = 0
        makeDebug.log = (...args: unknown[]) => { lines.push(args.join(' ')) }
    })
    afterEach(() => {
        makeDebug.log = original
        makeDebug.disable()
    })

    // a <-> b <-> c, both edges bidirectional
    const corridor = () => {
        const creator = new Graferse<string>(x => x)
        const locks = new Map(['a', 'b', 'c'].map(id => [id, creator.makeLock(id)]))
        const ab = creator.makeLinkLock('a', 'b', true)
        const bc = creator.makeLinkLock('b', 'c', true)
        const links = new Map([['a>b', ab], ['b>a', ab], ['b>c', bc], ['c>b', bc]])
        const makeLocker = creator.makeMakeLocker(
            (x: string) => locks.get(x)!,
            (from: string, to: string) => links.get(`${from}>${to}`)!)
        return { makeLocker }
    }

    test('reports who moved and what they were granted', () => {
        makeDebug.enable('graferse')
        const { makeLocker } = corridor()
        makeLocker('one').makePathLocker(['a', 'b', 'c'])(() => {}).arrivedAt(0)
        expect(said()).toEqual(['one at a → a, b'])
    })

    test('names what stopped a robot that got nothing', () => {
        makeDebug.enable('graferse')
        const { makeLocker } = corridor()
        makeLocker('one').makePathLocker(['a', 'b', 'c'])(() => {}).arrivedAt(0)
        lines.length = 0
        // the opposite way down the same corridor
        makeLocker('two').makePathLocker(['c', 'b', 'a'])(() => {}).arrivedAt(0)
        expect(said()).toEqual(['two at c → nothing — nothing to reserve from c'])
    })

    test('the walk detail is off unless its own namespace is on', () => {
        makeDebug.enable('graferse')
        const { makeLocker } = corridor()
        makeLocker('one').makePathLocker(['a', 'b', 'c'])(() => {}).arrivedAt(0)
        expect(lines.some(l => l.includes('┌─'))).toBe(false)

        makeDebug.enable('graferse*')
        lines.length = 0
        makeLocker('two').makePathLocker(['a', 'b', 'c'])(() => {}).arrivedAt(0)
        expect(lines.some(l => l.includes('┌─'))).toBe(true)
    })
})
