import { makeTrace } from './trace.js'
// Two levels of detail.  `graferse` is one line per arrivedAt - who moved,
// what they were granted, what stopped them - which is what you want almost
// always.  `graferse:walk` adds the per-edge reservation tree underneath it.
const summary = makeTrace('graferse')
const trace = makeTrace('graferse:walk')

type id = string | number

// a library must not touch built in prototypes, so this stays a plain function
function addAll<T>(target: Set<T>, source: Set<T> | undefined) {
    if (source) {
        source.forEach(item => target.add(item))
    }
}

function stringify(x: id) {
    return typeof x === 'string'
        ? x
        : JSON.stringify(x)
}

class Lock {
    id: string
    lockedBy: Set<string> = new Set()
    waiting: Set<string> = new Set()

    constructor(id: string) {
        this.id = id
    }

    requestLock (byWhom: string, what: string) {
        this.waiting.delete(byWhom)
        if (!this.isLocked()) {
            this.forceLock(byWhom)
            return true
        }

        if (this.isLocked(byWhom)) {
            // console.warn("Why are you locking your own node?", {byWhom, what})
            return true
        }

        trace.log(`${what} is locked, ${byWhom} will wait`)
        this.waiting.add(byWhom)
        return false
    }

    forceLock (byWhom: string) {
        // TODO distinguish between single(Node) and multi(Edge) locks
        // throw if single calls forceLock when already locked
        this.lockedBy.add(byWhom)
    }

    unlock (byWhom: string) {
        if (this.lockedBy.delete(byWhom)) {
            trace.log(`unlocked ${this.id} for ${byWhom}`)
        }

        if (this.waiting.delete(byWhom)) {
            trace.log(`stopped waiting ${this.id} for ${byWhom}`)
        }

        if (!this.isLocked()) {
            // no guarentee that this resource is obtainable by any of the waiters
            // so return all and let them obtain new waits on any new resources
            const waiters = new Set(this.waiting)
            this.waiting.clear()
            return waiters
        }
    }

    // drops a wait without releasing anything byWhom has locked
    stopWaiting (byWhom: string) {
        if (!this.waiting.delete(byWhom)) {
            return
        }
        trace.log(`stopped waiting ${this.id} for ${byWhom}`)

        if (!this.isLocked()) {
            // same as unlock, the remaining waiters get to try again
            const waiters = new Set(this.waiting)
            this.waiting.clear()
            return waiters
        }
    }

    isLocked(byWhom?: string) {
        return byWhom
            ? this.lockedBy.has(byWhom)
            : this.lockedBy.size > 0
    }

    isLockedByOtherThan(byWhom: string) {
        return this.lockedBy.size > 1
          || (this.lockedBy.size === 1 && !this.isLocked(byWhom))
    }
}

class LinkLock {
    private _lockers = new Map<string, Set<string>>()
    private _waiters = new Map<string, Set<string>>()
    private _otherdir = new Map<string, string>()

    check (direction: string) {
        if (!this._waiters.get(direction))
            throw new Error(`no such wait direction ${direction}`)
        if (!this._lockers.get(direction))
            throw new Error(`no such lock direction ${direction}`)
        if (!this._otherdir.get(direction))
            throw new Error(`no such other direction ${direction}`)
    }

    isWaiting (who: string) {
        return Array.from(this._otherdir.keys()).some(dir => {
            const waiters = this._waiters.get(dir)
            return waiters?.has(who)
        })
    }

    // a snapshot for logging and for convoy checks.  copies, so a caller
    // cannot reach into the live sets and change who holds the link
    getDetails() {
        const copy = (m: Map<string, Set<string>>) =>
            new Map([...m].map(([key, set]) => [key, new Set(set)]))
        return {
            lockers: copy(this._lockers),
            waiters: copy(this._waiters),
        }
    }

    // the two directions are symmetric, so which is which does not matter,
    // only that each is recorded as the other's opposite
    constructor (from: string, to: string) {
        this._lockers.set(from, new Set<string>())
        this._lockers.set(to, new Set<string>())

        this._waiters.set(from, new Set<string>())
        this._waiters.set(to, new Set<string>())

        this._otherdir.set(from, to)
        this._otherdir.set(to, from)
    }

    requestLock (byWhom: string, direction: string): boolean {
        this.check(direction)

        // I already have it locked in this direction
        const lockers = this._lockers.get(direction)
        if (!lockers) throw new Error("no lockers!")
        if (lockers.has(byWhom))
            return true

        // No one except me has it locked in the other direction
        const against = this._lockers.get(this._otherdir.get(direction) as string) || new Set()
        if (against.size === 0 || (against.size === 1 && against.has(byWhom))) {
            lockers.add(byWhom)
            return true
        }

        trace.log(`link from ${direction} is locked, ${byWhom} should wait`)
        this._waiters.get(direction)?.add(byWhom)

        return false
    }

    unlock (byWhom: string, direction?: string) {
        const dirsToUnlock = Array
            .from(this._otherdir.keys())
            .filter(dir => !direction || dir === direction)

        dirsToUnlock.forEach(dir => this._lockers.get(dir)?.delete(byWhom))

        const waiters = new Set<string>()

        dirsToUnlock.forEach(dir => {
            const otherdirwaiters = this._waiters.get(this._otherdir.get(dir) as string)
            otherdirwaiters?.forEach(waiter => {
                const tmp = new Set(this._lockers.get(dir))
                tmp.delete(waiter)
                if (tmp.size === 0) {
                    waiters.add(waiter)
                    otherdirwaiters.delete(waiter)
                }
            })
        })

        return waiters
    }

    // drops a wait without releasing anything byWhom has locked.  a waiter
    // never holds the link, so removing one cannot free it for anyone else
    stopWaiting (byWhom: string) {
        for (const waiters of this._waiters.values()) {
            waiters.delete(byWhom)
        }
    }

    isLocked(byWhom?: string) {
        return Array.from(this._otherdir.keys()).some(dir => {
            const lockers = this._lockers.get(dir) as Set<string>
            return byWhom
                ? lockers.has(byWhom)
                : lockers.size > 0
        })
    }

    // nobody holds or waits on either direction
    isIdle() {
        return Array.from(this._otherdir.keys()).every(dir =>
            (this._lockers.get(dir)?.size ?? 0) === 0
            && (this._waiters.get(dir)?.size ?? 0) === 0)
    }
}

class OnewayLinkLock extends LinkLock {
    // A one way edge has no opposing direction to contend over, so there is
    // nothing to reserve and nobody to wait for.  Traversal is governed by the
    // node locks alone.  Callers skip this via the instanceof check in
    // tryLockAllBidirectionalEdges, so it is only reached directly.
    requestLock (_byWhom: string, _direction: string): boolean {
        return true
    }
}

/** Outcome of reserving the bidirectional run ahead of a node. */
type Reservation = 'clear' | 'convoy' | 'blocked'

type NextNode = { node: id, index: number }
// two lock groups that can trap agents in each other, and the edges to blame
type LockGroupConflict = {
    groups: [Lock[], Lock[]]
    edges: [[Lock, Lock], [Lock, Lock]]
}
// TODO add a keep alive where owners need to report in periodically, else their locks will be freed
// where T is the type you will supply the path in
class Graferse<T>
{
    locks: Lock[] = []
    linkLocks: LinkLock[] = []
    lockGroups: Lock[][] = []
    lastCallCache = new Map<string,() => void>()
    // agents with a live path locker.  notifyWaiters can only replay an
    // agent id, so one agent may own one path: a second makePathLocker
    // for the same id would overwrite lastCallCache and strand the first
    private _agentsWithPath = new Set<string>()
    // pending waiters for the cascade currently draining.  nested
    // notifyWaiters calls unshift here instead of recursing
    private _notifyQueue: string[] = []
    private _notifying = false
    // "groupIndex:groupIndex" for every lock group pair joined in both
    // directions, stored under both orders
    private _quotientEdges = new Set<string>()
    private _reserveThroughLockGroups = true
    listeners: Array<() => void> = []
    identity: (x: T) => id

    constructor(
        identity: (x: T) => id,          // returns external node identity
    ) {
        this.identity = identity
    }

    makeLock(id: string) {
        const lock = new Lock(id)
        this.locks.push(lock)
        return lock
    }

    // Topology is yours: when a node or link goes away, drop its lock so
    // clearAllLocks and stopWaitingEverywhere stop walking it.  Refuses a
    // lock that is still held or waited on - removing it would strand
    // waiters that can never be granted - and one that sits in a lock
    // group, whose members setTopology has already contracted.
    removeLock(lock: Lock): boolean {
        if (lock.lockedBy.size > 0 || lock.waiting.size > 0) {
            throw new Error(`cannot remove lock ${lock.id}: still held or waited on`)
        }
        if (this.lockGroups.some(group => group.includes(lock))) {
            throw new Error(
                `cannot remove lock ${lock.id}: member of a lock group; `
                + `replace the group before removing the lock`)
        }
        const at = this.locks.indexOf(lock)
        if (at === -1) return false
        this.locks.splice(at, 1)
        return true
    }

    makeLinkLock(from: string, to: string, isBidirectional: boolean = false) {
        const linkLock = isBidirectional
            ? new LinkLock(from, to)
            : new OnewayLinkLock(from, to)

        this.linkLocks.push(linkLock)
        return linkLock
    }

    // same contract as removeLock: idle only
    removeLinkLock(linkLock: LinkLock): boolean {
        if (!linkLock.isIdle()) {
            throw new Error('cannot remove link lock: still held or waited on')
        }
        const at = this.linkLocks.indexOf(linkLock)
        if (at === -1) return false
        this.linkLocks.splice(at, 1)
        return true
    }

    addListener(listener: () => void) {
        this.listeners.push(listener)
    }

    notifyListeners() {
        for (const listener of this.listeners) {
            listener()
        }
    }

    // Each waiter is told to try again by replaying its last arrivedAt.  That
    // call may free further waiters, which enqueue at the front of the queue
    // so the walk stays depth-first: A, then A's cascade, then B - the same
    // order the old recursion produced, but with O(1) stack regardless of how
    // long the freed chain is.  Everything still runs synchronously before
    // the original caller returns.
    //
    // Two limits remain:
    //
    //   - agents that keep freeing each other are not detected; only the lock
    //     state changing at each step ends the cascade
    //   - a listener or callback that does heavy work blocks every agent still
    //     queued behind it
    //
    // Listeners fire once when the top-level cascade drains, not once per
    // nested hop.
    //
    // Throws when a waiter has no cached call, which happens if you took a
    // lock with requestLock directly instead of through arrivedAt.  There is
    // no way to tell such an agent to retry, so the alternative is a silent
    // stall.  On throw the rest of the queue is dropped: half a cascade is
    // not resumed on the next release.
    notifyWaiters(whoCanMoveNow: Set<string>) {
        if (this._notifying) {
            // nested: run these before whatever is already queued, so a
            // waiter's own cascade finishes before its siblings
            this._notifyQueue.unshift(...whoCanMoveNow)
            return
        }

        this._notifyQueue = [...whoCanMoveNow]
        this._notifying = true
        try {
            while (this._notifyQueue.length > 0) {
                const waiter = this._notifyQueue.shift() as string
                const lastCall = this.lastCallCache.get(waiter)
                if (!lastCall) {
                    throw new Error(`lastCallCached did not have expect entry for ${waiter}`)
                }
                lastCall()
            }
        } finally {
            this._notifying = false
            // drop anything a throwing callback left behind
            this._notifyQueue = []
        }
        this.notifyListeners()
    }

    clearAllLocks(byWhom: string) {
        trace.open(`clearAllLocks | ${byWhom}`)
        try {
            // nothing is left to replay, and the closure would otherwise be held
            // for the life of the graph
            this.lastCallCache.delete(byWhom)
            this._agentsWithPath.delete(byWhom)
            const whoCanMoveNow = new Set<string>()
            for (const lock of this.locks) {
                addAll(whoCanMoveNow, lock.unlock(byWhom))
            }
            for (const linkLock of this.linkLocks) {
                addAll(whoCanMoveNow, linkLock.unlock(byWhom))
                // unlock never drops our own wait, only grants other waiters
                linkLock.stopWaiting(byWhom)
            }
            // link unlock can hand us back our own name; nothing left to replay
            whoCanMoveNow.delete(byWhom)
            this.notifyWaiters(whoCanMoveNow)
        } finally { trace.close() }
    }

    // a waiter can be parked on a lock that is not on its own path, eg a lock
    // group member or a link met while reserving.  such a wait outlives
    // clearAllPathLocks unless swept here, and would later replay an
    // abandoned path
    stopWaitingEverywhere(byWhom: string) {
        const whoCanMoveNow = new Set<string>()
        for (const lock of this.locks) {
            addAll(whoCanMoveNow, lock.stopWaiting(byWhom))
        }
        for (const linkLock of this.linkLocks) {
            linkLock.stopWaiting(byWhom)
        }
        return whoCanMoveNow
    }

    // At most one agent may hold any node in the group, so a group behaves as
    // one node spread over several places.  Two groups joined by edges running
    // in BOTH directions can deadlock, which setTopology solves.
    //
    // Exclusion is per group and does NOT spread between groups that share a
    // node.  With groups [A,B] and [B,C], an agent holding A blocks B, but
    // leaves C free.  The groups do not merge into one.  setTopology reasons
    // about a quotient graph, where contraction WOULD merge them, so its
    // reserve through walk is only exact while groups stay disjoint.
    setLockGroup(lockGroup: Lock[]) {
        this.lockGroups.push(lockGroup)
    }

    // Hand over the directed edges so the reservation walk can see the quotient
    // graph.  Returns the same conflicts findLockGroupConflicts reports, so it
    // doubles as the check.
    //
    // Pass { reserveThroughLockGroups: false } to opt out and keep the old
    // behaviour, where a conflicting pair is only reported, never reserved
    // through.  Then avoiding the deadlock is yours to do.
    setTopology(
        edges: Array<[Lock, Lock]>,
        { reserveThroughLockGroups = true } = {},
    ): LockGroupConflict[] {
        const conflicts = this.findLockGroupConflicts(edges)
        this._reserveThroughLockGroups = reserveThroughLockGroups
        this._quotientEdges.clear()
        for (const conflict of conflicts) {
            const a = this.lockGroups.indexOf(conflict.groups[0])
            const b = this.lockGroups.indexOf(conflict.groups[1])
            this._quotientEdges.add(`${a}:${b}`)
            this._quotientEdges.add(`${b}:${a}`)
        }
        return conflicts
    }

    // True when stepping from one lock group into another that is joined back
    // to it, ie a bidirectional edge in the quotient graph.  The real edges are
    // one way, so nothing else would notice.
    crossesQuotientEdge(from: Lock, to: Lock) {
        if (!this._reserveThroughLockGroups || this._quotientEdges.size === 0) {
            return false
        }
        return this.lockGroups.some((fromGroup, a) =>
            fromGroup.includes(from) && this.lockGroups.some((toGroup, b) =>
                toGroup !== fromGroup
                && toGroup.includes(to)
                && this._quotientEdges.has(`${a}:${b}`)))
    }

    // Contract each lock group to a single node and you get a quotient graph.
    // A pair of groups joined in both directions becomes a bidirectional edge
    // there, but the real edges are one way, so tryLockAllBidirectionalEdges
    // never sees it and nothing reserves through to a safe state.  Two agents
    // approaching from opposite ends then wedge.
    //
    // Graferse never sees the topology, only locks and a getLockForLink
    // callback, so the caller must supply the directed edges.
    findLockGroupConflicts(edges: Array<[Lock, Lock]>): LockGroupConflict[] {
        const groupsOf = (lock: Lock) =>
            this.lockGroups.filter(group => group.includes(lock))

        // "from group index > to group index" -> an edge that produced it
        const between = new Map<string, [Lock, Lock]>()
        for (const [from, to] of edges) {
            for (const fromGroup of groupsOf(from)) {
                for (const toGroup of groupsOf(to)) {
                    if (fromGroup === toGroup) continue
                    const key = `${this.lockGroups.indexOf(fromGroup)}>${this.lockGroups.indexOf(toGroup)}`
                    if (!between.has(key)) between.set(key, [from, to])
                }
            }
        }

        const conflicts: LockGroupConflict[] = []
        for (const [key, forward] of between) {
            const [a, b] = key.split('>').map(Number)
            if (a >= b) continue // report each pair once
            const back = between.get(`${b}>${a}`)
            if (back) {
                conflicts.push({
                    groups: [this.lockGroups[a], this.lockGroups[b]],
                    edges: [forward, back],
                })
            }
        }
        return conflicts
    }

    getLockedGroupLock(lock: Lock, byWhom: string) {
        for(const lockGroup of this.lockGroups) {
            if (lockGroup.includes(lock)) {
                const lockedNode = lockGroup.filter(l => l !== lock)
                    .find(l => l.isLockedByOtherThan(byWhom))
                if (lockedNode) {
                    return lockedNode
                }
            }
        }
    }

    isLockGroupAvailable(lock: Lock, byWhom: string) {
        const lockedNode = this.getLockedGroupLock(lock, byWhom)
        if (lockedNode) {
            // Park on the group member that is in the way.  requestLock can
            // still succeed: isLockedByOtherThan is true whenever several
            // holders share the lock, and byWhom may already be one of them.
            // That is not a contradiction - we already hold it - so the group
            // is available to us.  Throwing here would strand every lock this
            // arrivedAt call has taken so far.
            if (lockedNode.requestLock(byWhom, "lockGroup")) {
                trace.log(`group member ${lockedNode.id} already held by ${byWhom}`)
            } else {
                return false
            }
        }
        return true
    }

    makeMakeLocker (
        getLock: (x: T) => Lock,                   // given a T, gives you a Lock
        getLockForLink: (from: T, to: T) => LinkLock,
    ) {
        type NextNodes = (nextNodes: NextNode[], remaining: number) => void
        return (byWhom: string) => {
            const waitOnObstructor = (destinationNode: T, encounteredLocks: Set<Lock>) => {
                // Wait on the nearest obstruction: freeing it replays us into
                // a re-evaluation, so followers trail one node behind instead
                // of stalling until the whole chain ahead clears.
                const lock = getLock(destinationNode)
                const lastEncouteredLock = Array.from(encounteredLocks).at(-1)
                    || (lock.isLockedByOtherThan(byWhom) ? lock : undefined)
                    || this.getLockedGroupLock(lock, byWhom)
                if (lastEncouteredLock) {
                    // Every candidate was held by someone other than byWhom
                    // when picked, and nothing runs in between, so success can
                    // only mean we are one of several holders sharing it
                    // (isLockedByOtherThan is true then too).  There is nothing
                    // to wait for, and a throw would abandon the node and link
                    // locks this walk has already taken.  Were it ever free,
                    // requestLock would take it here as a side effect.
                    if (lastEncouteredLock.requestLock(byWhom, "capacity")) {
                        trace.log(`${lastEncouteredLock.id} already held by ${byWhom}`)
                        return false
                    }
                    return true
                }
            }

            const makePathLocker = (path: T[]) => (callback: NextNodes) => {
                // notifyWaiters can only find an agent by id, so a second
                // path for the same agent would overwrite lastCallCache and
                // leave waiters replaying the wrong corridor
                if (this._agentsWithPath.has(byWhom)) {
                    throw new Error(
                        `agent ${byWhom} already has a path locker; `
                        + `clear it before making another`)
                }
                this._agentsWithPath.add(byWhom)
                // Walks the path from a node, reserving every bidirectional
                // edge until it reaches a safe place to stop.  Reports:
                //   'clear'   reserved through to a safe stop - take the node
                //             and keep looking further ahead
                //   'convoy'  the only thing in the way is traffic already
                //             moving OUR way, and we hold the edges up to it.
                //             Take the node, stop there, wait to be replayed
                //   'blocked' oncoming traffic, or nothing to be had - release
                //             everything and stay put
                let pivotNode: T|undefined
                let edgesHeld = 0
                // Every obstruction we met was a vehicle travelling our way.
                // A convoy is just one longer vehicle: it leaves by the exit
                // its head already reserved, so we may queue behind it instead
                // of refusing to enter.  One obstruction that is NOT part of
                // our convoy (idle, or turning off) clears this: it owes us no
                // exit, so the old all-or-nothing rule applies.
                let convoyOnly = true
                const encounteredLocks = new Set<Lock>()
                const obstructed = (): Reservation =>
                    edgesHeld > 0 && convoyOnly ? 'convoy' : 'blocked'
                // A vehicle is in our convoy if it holds the edge we came in
                // on, in the same direction we hold it.  Anything else on that
                // node is stopped, or leaving sideways, and cannot be followed.
                const travellingWithUs = (lock: Lock, via: {link: LinkLock, from: string}) => {
                    const sameWay = via.link.getDetails().lockers.get(via.from)
                    if (!sameWay) return false
                    return [...lock.lockedBy].every(who => who === byWhom || sameWay.has(who))
                }
                // The frame opens on the way IN, so a corridor reads in
                // travel order.  The outcome lines used to fire as the
                // recursion unwound, which listed the edges from the far end
                // back to us - the reverse of the way the robot drives them.
                const tryLockAllBidirectionalEdges = (
                    subpath: T[],
                    via?: {link: LinkLock, from: string},
                ): Reservation => {
                    trace.open(subpath.length > 1
                        ? `${this.identity(subpath[0])} → ${this.identity(subpath[1])}`
                        : `${this.identity(subpath[0])} (end of path)`)
                    try {
                        // No outcome here: every frame but one is propagating
                        // the same verdict back up, and naming it at each
                        // level buries the frame that actually decided it.
                        // The walk is reported once, by the caller.
                        return reserveFrom(subpath, via)
                    } finally {
                        trace.close()
                    }
                }
                const reserveFrom = (
                    subpath: T[],
                    via?: {link: LinkLock, from: string},
                ): Reservation => {
                    // check if the path turns back on itself
                    if (subpath.length > 2) {
                        if (this.identity(subpath[0]) === this.identity(subpath[2]))
                            pivotNode = subpath[1]
                    }
                    if (subpath.length > 0) {
                        const lock = getLock(subpath[0])
                        if (lock.isLockedByOtherThan(byWhom)) {
                            encounteredLocks.add(lock)
                            if (!via || !travellingWithUs(lock, via)) {
                                trace.log(`${this.identity(subpath[0])} is held by traffic not travelling with us`)
                                convoyOnly = false
                            }
                        }
                    }
                    if (subpath.length < 2) {
                        // we ended our path on a bidir edge (likely a trolly location)
                        // fail, and wait on the last lock we encountered
                        if (waitOnObstructor(pivotNode || subpath[0], encounteredLocks)) {
                            return obstructed()
                        }
                        return 'clear'
                    }
                    // TODO will these locks and unlocks trigger waiters?
                    // may need a cangetlock? function.  prepare lock?
                    const linkLock = getLockForLink(subpath[0], subpath[1])
                    const fromNodeId = stringify(this.identity(subpath[0]))
                    if (linkLock instanceof OnewayLinkLock) {
                        // A one way edge is normally a safe state to stop at.
                        // It is not, when the step crosses between two lock
                        // groups joined in both directions: that is a
                        // bidirectional edge in the quotient graph, so keep
                        // walking and only enter if the far group is free too.
                        if (this.crossesQuotientEdge(getLock(subpath[0]), getLock(subpath[1]))) {
                            trace.log('crosses a quotient edge, reserving through')
                            if (!this.isLockGroupAvailable(getLock(subpath[1]), byWhom)) {
                                trace.log('far lock group is taken')
                                return 'blocked'
                            }
                            return tryLockAllBidirectionalEdges(subpath.slice(1))
                        }
                        trace.log('one way, a safe place to stop')
                        if (pivotNode) {
                            if (waitOnObstructor(pivotNode, encounteredLocks)) {
                                return obstructed()
                            }
                        }
                        return 'clear'
                    }

                    const linkLockResult = linkLock.requestLock(byWhom, fromNodeId)

                    // if it failed to lock because of opposing direction
                    if (!linkLockResult) {
                        trace.log('locked against us %o', linkLock.getDetails())
                        return 'blocked'
                    }
                    edgesHeld++

                    const ahead = tryLockAllBidirectionalEdges(subpath.slice(1), {link: linkLock, from: fromNodeId})
                    if (ahead === 'blocked') {
                        edgesHeld--
                        linkLock.unlock(byWhom, fromNodeId)
                        return 'blocked'
                    }

                    // 'convoy' keeps this edge: it is what tells oncoming
                    // traffic the section is claimed in our direction while
                    // we sit in it.
                    return ahead
                }

                const clearAllPathLocks = () => {
                    trace.open(`clearAllPathLocks | ${byWhom}`)
                    try {
                        // this path is over, so it must never be replayed
                        this.lastCallCache.delete(byWhom)
                        this._agentsWithPath.delete(byWhom)
                        const whoCanMoveNow = new Set<string>()
                        for (let i = 0; i < path.length; i++) {
                            addAll(whoCanMoveNow, getLock(path[i]).unlock(byWhom))
                            if (i < path.length -1) // except the last node
                                addAll(whoCanMoveNow, getLockForLink(path[i], path[i+1]).unlock(byWhom))
                        }
                        addAll(whoCanMoveNow, this.stopWaitingEverywhere(byWhom))
                        // link locks can hand us back our own name, and we have
                        // nothing left to replay
                        whoCanMoveNow.delete(byWhom)
                        this.notifyWaiters(whoCanMoveNow)
                    } finally { trace.close() }
                }

                const arrivedAt = (currentIdx: number) => {
                    trace.open(`${byWhom} at ${this.identity(path[currentIdx])} [${currentIdx}]`)
                    try {
                        this.lastCallCache.set(byWhom, () => arrivedAt(currentIdx))


                        // lock the next node (currentIdx is already held by
                        // the agent standing there)
                        const lastIdx = path.length -1
                        const firstToLock = currentIdx               // first to be locked
                        const lastToLock = Math.min(currentIdx + 1, lastIdx) // last to be locked
                        const whoCanMoveNow = new Set<string>()

                        const nextNodes: NextNode[] = []
                        let stopped = ''
                        // go through path from start to last node to be locked
                        for (let i = 0; i <= lastToLock; i++) {
                            // unlock all edges before current position
                            if (i > 0 && i <= currentIdx) {
                                const fromNodeId = stringify(this.identity(path[i-1]))
                                addAll(whoCanMoveNow, getLockForLink(path[i-1], path[i]).unlock(byWhom, fromNodeId))
                            }

                            // if its behind the firstToLock, unlock it
                            if (i < firstToLock) {
                                addAll(whoCanMoveNow, getLock(path[i]).unlock(byWhom))
                                continue
                            }

                            const lock = getLock(path[i])
                            if (!this.isLockGroupAvailable(lock, byWhom)) {
                                trace.log('could not obtain lock, group is locked')
                                stopped = `lock group holding ${this.identity(path[i])} is taken`
                                break;
                            }
                            /* Lock from firstToLock to lastToLock */
                            // if failed to obtain lock, dont try to get any more
                            if (!lock.requestLock(byWhom, stringify(this.identity(path[i])))) {
                                stopped = `${this.identity(path[i])} is taken`
                                break;
                            }

                            encounteredLocks.clear()
                            pivotNode = undefined
                            edgesHeld = 0
                            convoyOnly = true
                            const reservation = tryLockAllBidirectionalEdges(path.slice(i))
                            trace.log(`reserving from ${this.identity(path[i])}: ${reservation}`)
                            if (reservation === 'blocked') {
                                // unlock previously obtained node lock
                                addAll(whoCanMoveNow, lock.unlock(byWhom))
                                stopped = `nothing to reserve from ${this.identity(path[i])}`
                                break
                            }
                            trace.log(`encountered ${encounteredLocks.size} locks along the way`)
                            if (reservation === 'convoy') {
                                // Keep the node and the edges we hold.  How far we
                                // get is then decided by the node locks alone, so
                                // we close up behind the vehicle ahead and stop on
                                // the node before it.
                            }
                            nextNodes.push({node: this.identity(path[i]), index: i})
                        }

                        trace.log('can move now: %o', [...whoCanMoveNow])
                        summary.log(
                            `${byWhom} at ${this.identity(path[currentIdx])}`
                            + ` → ${nextNodes.map(n => n.node).join(', ') || 'nothing'}`
                            + (stopped ? ` — ${stopped}` : ''))
                        // TODO consider not calling back with same values as last time or leave it up to clients to handle this
                        callback(
                            nextNodes,
                            path.length - (currentIdx +1)
                        )

                        this.notifyWaiters(whoCanMoveNow)
                    } finally { trace.close() }
                }

                // Idle agents keep holding the node they sit on, so nobody
                // routes through them.  Everything else is released.
                const clearAllExceptLastPathLocks = () => {
                    trace.open(`clearAllExceptLastPathLocks | ${byWhom}`)
                    try {
                        let lastLock = -1
                        for (let i = 0; i < path.length; i++) {
                            if (getLock(path[i]).isLocked(byWhom)) lastLock = i
                        }
                        if (lastLock === -1) return clearAllPathLocks()
                        // the path is over: the agent idles on its last node
                        // and waits nowhere, so there is nothing to replay and
                        // it is free to start its next path
                        this.lastCallCache.delete(byWhom)
                        this._agentsWithPath.delete(byWhom)
                        const whoCanMoveNow = new Set<string>()
                        for (let i = 0; i < path.length; i++) {
                            // unlock every link to ensure we dont leave any dangling
                            if (i < path.length -1) {
                                const fromNodeId = stringify(this.identity(path[i]))
                                addAll(whoCanMoveNow, getLockForLink(path[i], path[i+1]).unlock(byWhom, fromNodeId))
                            }

                            if (i >= lastLock) {
                                // keep the node we sit on (and any alias of it),
                                // but drop our own waits there
                                getLock(path[i]).stopWaiting(byWhom)
                                continue
                            }

                            if (getLock(path[i]) === getLock(path[lastLock])) {
                                trace.log(`last lock also at position ${i}, skipping`)
                                continue
                            }
                            trace.log(`unlocking ${this.identity(path[i])} for ${byWhom}`)
                            addAll(whoCanMoveNow, getLock(path[i]).unlock(byWhom))
                        }
                        addAll(whoCanMoveNow, this.stopWaitingEverywhere(byWhom))
                        whoCanMoveNow.delete(byWhom)
                        this.notifyWaiters(whoCanMoveNow)
                    } finally { trace.close() }
                }

                return {
                    arrivedAt,
                    clearAllPathLocks,
                    clearAllExceptLastPathLocks,
                }
            }
            return {
                makePathLocker,
                clearAllLocks: () => this.clearAllLocks(byWhom)
            }
        }
    }

}

export { Graferse }
export type { Lock, LinkLock, NextNode, LockGroupConflict, Reservation }
