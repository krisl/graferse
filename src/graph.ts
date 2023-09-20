import makeDebug from 'debug'
const debug = makeDebug('graferse')

declare global {
    interface Set<T> {
        addAll(s: Set<T> | undefined): void
    }
}

Set.prototype.addAll = function(s) {
    if (s) {
        s.forEach(item => this.add(item))
    }
}

function stringify(x: any) {
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

        debug(`Resource ${what} is locked, ${byWhom} will wait`)
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
          debug(`unlocked ${this.id} for ${byWhom}`)
        }

        if (this.waiting.delete(byWhom)) {
          debug(`stopped waiting ${this.id} for ${byWhom}`)
        }

        if (!this.isLocked()) {
            // no guarentee that this resource is obtainable by any of the waiters
            // so return all and let them obtain new waits on any new resources
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

type LinkLockType = "FREE" | "PRO" | "CON"

class LinkLock {
    private _lock: Lock = new Lock("linklock")
    private _directions: Set<string> = new Set()

    getDetails() {
        return {
            directions: this._directions,
            who: this._lock.lockedBy,
        }
    }

    requestLock (byWhom: string, direction: string): LinkLockType {
        // already locked by me
        if (this._lock.isLocked(byWhom)) {
            if (this._directions.size === 1 && !this._directions.has(direction)) {
                if (this._lock.isLockedByOtherThan(byWhom))
                    return "CON"
                this._directions.add(direction)
            }
            return "FREE"
        }

        // if its locked by anyone else, in the direction we are going
        if (this._lock.isLocked() && this._directions.size === 1 && this._directions.has(direction)) {
            this._lock.forceLock(byWhom) // add ourselves to the list
            return "PRO"
        }

        // its not locked by anyone
        if (this._lock.requestLock(byWhom, "link from " + direction)) {
            this._directions.add(direction)
            return "FREE"
        }

        return "CON"
    }

    unlock (byWhom: string, direction?: string) {
        // if its locked only by a single robot
        if (this._lock.isLocked(byWhom) && !this._lock.isLockedByOtherThan(byWhom)) {
            if (direction) {
                this._directions.delete(direction)

                // if we still are holding one direction, dont release lock
                if (this._directions.size > 0)
                    return
            } else {
                this._directions.clear()
            }
        }

        return this._lock.unlock(byWhom)
    }

    isLocked(byWhom?: string) {
        return this._lock.isLocked(byWhom)
    }
}

class OnewayLinkLock extends LinkLock {
    requestLock (byWhom: string, direction: string): LinkLockType {
        console.error("Who is trying to lock a non-bidir link?", {byWhom, direction})
        console.warn("This will cause problems because it should stop locking here")
        return "FREE"
    }
}

type NextNode<U> = { node: U, index: number }
// TODO add a keep alive where owners need to report in periodically, else their locks will be freed
class Graferse<T,U=string>
{
    locks: Lock[] = []
    linkLocks: LinkLock[] = []
    lockGroups: Lock[][] = []
    lastCallCache = new Map<string,() => void>()
    listeners: Array<() => void> = []
    identity: (x: T) => U

    constructor(
        identity: (x: T) => U,          // returns external node identity
    ) {
        this.identity = identity
    }

    makeLock(id: string) {
        const lock = new Lock(id)
        this.locks.push(lock)
        return lock
    }

    makeLinkLock(isBidirectional: boolean = false) {
        const linkLock = isBidirectional
            ? new LinkLock()
            : new OnewayLinkLock()

        this.linkLocks.push(linkLock)
        return linkLock
    }

    addListener(listener: () => void) {
        this.listeners.push(listener)
    }

    notifyListeners() {
        for (const listener of this.listeners) {
            listener()
        }
    }

    notifyWaiters(whoCanMoveNow: Set<string>) {
        for (const waiter of whoCanMoveNow) {
            const lastCall = this.lastCallCache.get(waiter)
            if (!lastCall) {
                throw new Error(`lastCallCached did not have expect entry for ${waiter}`)
            }
            lastCall()
        }
        this.notifyListeners()
    }

    clearAllLocks(byWhom: string) {
        debug(`── clearAllLocks | ${byWhom} ──`);
        const whoCanMoveNow = new Set<string>()
        for (const lock of this.locks) {
            whoCanMoveNow.addAll(lock.unlock(byWhom))
        }
        for (const linkLock of this.linkLocks) {
            whoCanMoveNow.addAll(linkLock.unlock(byWhom))
        }
        this.notifyWaiters(whoCanMoveNow)
    }

    setLockGroup(lockGroup: Lock[]) {
        this.lockGroups.push(lockGroup)
    }

    isLockGroupAvailable(lock: Lock, byWhom: string) {
        for(const lockGroup of this.lockGroups) {
            if (lockGroup.includes(lock)) {
                const lockedNode = lockGroup.filter(l => l !== lock)
                                            .find(l => l.isLockedByOtherThan(byWhom))
                if (lockedNode) {
                    // wait on this locked node
                    if (lockedNode.requestLock(byWhom, "lockGroup")) {
                        throw new Error("lock was locked, but then not?")
                    }
                    return false
                }
            }
        }
        return true
    }

    makeMakeLocker (
            getLock: (x: T) => Lock,                   // given a T, gives you a Lock
            getLockForLink: (from: T, to: T) => LinkLock,
    ) {
        type NextNodes = (nextNodes: NextNode<U>[], remaining: number) => void
        return (byWhom: string) => {
            const makePathLocker = (path: T[]) => (callback: NextNodes) => {
                // given an index in the path, tries to lock all bidirectional edges
                // till the last node in the path
                // returns false if first edge fails, otherwise returns true
                // as we can proceed some of the way in the same direction
                const tryLockAllBidirectionalEdges = (subpath: T[]) => {
                    if (subpath.length < 2) {
                        return true
                    }
                    // TODO will these locks and unlocks trigger waiters?
                    // may need a cangetlock? function.  prepare lock?
                    const linkLock = getLockForLink(subpath[0], subpath[1])
                    const desc = `from ${this.identity(subpath[0])} to ${this.identity(subpath[1])}`
                    const fromNodeId = stringify(this.identity(subpath[0]))
                    if (linkLock instanceof OnewayLinkLock) {
                        console.debug(`  ok - ${desc} not bidirectional`)
                        return true
                    }

                    const linkLockResult = linkLock.requestLock(byWhom, fromNodeId)

                    // if it failed to lock because of opposing direction
                    if (linkLockResult === "CON") {
                        console.warn(`  fail - ${desc} locked against us`)
                        console.warn(linkLock.getDetails())
                        return false
                    }

                    if (!tryLockAllBidirectionalEdges(subpath.slice(1))) {
                        linkLock.unlock(byWhom, fromNodeId)
                        return false
                    }

                    console.debug(`  ok - ${desc} obtained`)
                    return true
                }

                const clearAllPathLocks = () => {
                    debug(`── clearAllPathLocks | ${byWhom} ──`);
                    const whoCanMoveNow = new Set<string>()
                    for (let i = 0; i < path.length; i++) {
                        whoCanMoveNow.addAll(getLock(path[i]).unlock(byWhom))
                        if (i < path.length -1) // except the last node
                            whoCanMoveNow.addAll(getLockForLink(path[i], path[i+1]).unlock(byWhom))
                    }
                    this.notifyWaiters(whoCanMoveNow)
                }

                const lockNext = (currentNode: U) => {
                    console.warn("lockNext is deprecated, please use arrivedAt")
                    const currentIdx = path.findIndex(node => this.identity(node) === currentNode)
                    if (currentIdx === -1) {
                        console.error(`  You're claiming to be at a node not on your path`)
                        console.error(`  Couldnt find "${currentNode}" in ${stringify(path.map(this.identity))}`)
                        clearAllPathLocks()
                        return
                    }
                    arrivedAt(currentIdx)
                }

                const arrivedAt = (currentIdx: number) => {
                    debug(`┌─ Lock | ${byWhom} ${currentIdx} ${this.identity(path[currentIdx])} ──`);
                    this.lastCallCache.set(byWhom, () => arrivedAt(currentIdx))


                    const beforeCount = 0, afterCount = 1
                    const lastIdx = path.length -1
                    const firstToLock = Math.max(currentIdx - beforeCount, 0)      // first to be locked
                    const lastToLock = Math.min(currentIdx + afterCount, lastIdx) // last to be locked
                    const whoCanMoveNow = new Set<string>()

                    const nextNodes: NextNode<U>[] = []
                    // go through path from start to last node to be locked
                    for (let i = 0; i <= lastToLock; i++) {
                        // unlock all edges before current position
                        if (i > 0 && i <= currentIdx) {
                            const fromNodeId = stringify(this.identity(path[i-1]))
                            whoCanMoveNow.addAll(getLockForLink(path[i-1], path[i]).unlock(byWhom, fromNodeId))
                        }

                        // if its behind the firstToLock, unlock it
                        if (i < firstToLock) {
                            whoCanMoveNow.addAll(getLock(path[i]).unlock(byWhom))
                            continue
                        }

                        const lock = getLock(path[i])
                        if (!this.isLockGroupAvailable(lock, byWhom)) {
                            debug("Could not obtain lock, group is locked")
                            break;
                        }
                        /* Lock from firstToLock to lastToLock */
                        // if failed to obtain lock, dont try to get any more
                        if (!lock.requestLock(byWhom, stringify(this.identity(path[i])))) {
                            break;
                        }
                        debug("  trying to lock bidir edges from node %o", this.identity(path[i]))
                        // TODO consider returning the length of obtained edge locks
                        // if its > 0, even though further failed, allow the againt to retain the node lock
                        // so we can enter corridors as far as we can and wait there
                        if (!tryLockAllBidirectionalEdges(path.slice(i))) {
                            // unlock previously obtained node lock
                            whoCanMoveNow.addAll(lock.unlock(byWhom))
                            break
                        }
                        nextNodes.push({node: this.identity(path[i]), index: i})
                    }

                    debug({whoCanMoveNow})
                    // TODO consider not calling back with same values as last time or leave it up to clients to handle this
                    callback(
                        nextNodes,
                        path.length - (currentIdx +1)
                    )

                    this.notifyWaiters(whoCanMoveNow)
                    debug('└────\n')
                }

                return {
                    lockNext,
                    arrivedAt,
                    clearAllPathLocks,
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
export type { Lock, LinkLock, NextNode }
