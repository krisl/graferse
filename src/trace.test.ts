import makeDebug from 'debug'
import { makeTrace, traceDepth, resetTraceDepth } from './trace.js'

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
