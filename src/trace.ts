import makeDebug from 'debug'
import type { Debugger } from 'debug'

// A console that indents groups for us.  node has console.group, but it adds
// no indentation once the log is piped or redirected, so only a browser
// console is trusted here; everywhere else the terminal renderer draws the
// nesting itself.
const grouping =
    typeof (globalThis as {window?: unknown}).window !== 'undefined' &&
    typeof console !== 'undefined' &&
    typeof console.group === 'function'

// The walk is synchronous, so one module level depth is enough.
let depth = 0

/** Current nesting depth.  Frames must balance: tests assert this reaches 0. */
const traceDepth = () => depth

/** Drop back to the top level after a trace was abandoned mid-frame. */
const resetTraceDepth = () => { depth = 0 }

const indent = () => '│ '.repeat(depth)

interface Trace {
    /**
     * Open a nesting level.  ALWAYS pair with close() from a finally block:
     * an unbalanced open leaves a browser console indented for good.
     */
    open(label: string, ...detail: unknown[]): void
    /** Close the innermost level, naming how it ended. */
    close(outcome?: string): void
    /** One line at the current level. */
    log(...args: unknown[]): void
    /** False when this namespace is switched off, so callers can skip work. */
    readonly enabled: boolean
}

/**
 * Nesting-aware logging over `debug`.
 *
 * Call sites describe structure — open a frame, log inside it, close it —
 * and each environment renders that structure its own way: real collapsible
 * groups in a browser console, drawn box characters in a terminal.
 */
function makeTrace(namespace: string): Trace {
    const emit: Debugger = makeDebug(namespace)
    return {
        get enabled() { return emit.enabled },
        open(label: string, ...detail: unknown[]) {
            if (!emit.enabled) return
            // collapsed: a walk is usually noise until it is the walk you want
            if (grouping) console.groupCollapsed(`${namespace} ${label}`, ...detail)
            else emit(`${indent()}┌─ ${label}`, ...detail)
            depth++
        },
        close(outcome?: string) {
            if (!emit.enabled) return
            depth = Math.max(0, depth - 1)
            if (grouping) {
                if (outcome) console.debug(outcome)
                console.groupEnd()
                return
            }
            // A terminal frame ends where the indent drops, so a closing line
            // earns its place only when it carries an outcome.
            if (outcome) emit(`${indent()}└─ ${outcome}`)
        },
        log(...args: unknown[]) {
            if (!emit.enabled) return
            if (grouping) return void console.debug(...args)
            const [first, ...rest] = args
            if (typeof first === 'string') emit(`${indent()}${first}`, ...rest)
            else emit(`${indent()}%o`, ...args)
        },
    }
}

export { makeTrace, traceDepth, resetTraceDepth }
export type { Trace }
