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

class Lock {
    lockedBy: Set<string> = new Set()
    waiting: Set<string> = new Set()

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
        this.waiting.delete(byWhom)
        this.lockedBy.delete(byWhom)

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
    private _lock: Lock = new Lock()
    private _directions: Set<string> = new Set()
    readonly isBidirectional: boolean

    constructor(isBidirectional: boolean = false) {
        this.isBidirectional = isBidirectional  // only relevent for edges
    }

    requestLock (byWhom: string, direction: string) {
        if (!this.isBidirectional) {
            console.error("Who is trying to lock a non-bidir link?", {byWhom, direction})
            console.warn("This will cause problems because it should stop locking here")
            return "FREE"
        }

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
        if (direction) {
            if (this._lock.isLocked(byWhom) && !this._lock.isLockedByOtherThan(byWhom)) {
                this._directions.delete(direction)
                // if we still are holding one direction, dont release lock
                if (this._directions.size > 0)
                    return
            }
        }
        return this._lock.unlock(byWhom)
    }

    isLocked(byWhom?: string) {
        return this._lock.isLocked(byWhom)
    }
}

// TODO add a keep alive where owners need to report in periodically, else their locks will be freed
class Graferse
{
    locks: Lock[] = []
    linkLocks: LinkLock[] = []
    lockGroups: Lock[][] = []
    lastCallCache = new Map<string,() => void>()
    listeners: Array<() => void> = []

    makeLock() {
        const lock = new Lock()
        this.locks.push(lock)
        return lock
    }

    makeLinkLock(isBidirectional: boolean = false) {
        const linkLock = new LinkLock(isBidirectional)
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
}

type NextNode<U> = { node: U, index: number }
function makeMakeLocker<T,U=string> (
        creator: Graferse,
        getLock: (x: T) => Lock,                   // given a T, gives you a Lock
        getLockForLink: (from: T, to: T) => LinkLock,
        identity: (x: T) => U,          // returns external node identity
) {
    type NextNodes = (nextNodes: NextNode<U>[], remaining: number) => void
    return (byWhom: string) => {
        const makePathLocker = (path: T[]) => (callback: NextNodes) => {
            // given an index in the path, tries to lock all bidirectional edges
            // till the last node in the path
            // returns false if first edge fails, otherwise returns true
            // as we can proceed some of the way in the same direction
            function tryLockAllBidirectionalEdges(subpath: T[]) {
                if (subpath.length < 2) {
                    return true
                }
                // TODO will these locks and unlocks trigger waiters?
                // may need a cangetlock? function.  prepare lock?
                const linkLock = getLockForLink(subpath[0], subpath[1])
                const desc = `from ${identity(subpath[0])} to ${identity(subpath[1])}`
                const fromNodeId = JSON.stringify(identity(subpath[0]))
                if (!linkLock.isBidirectional) {
                    console.debug(`  ok - ${desc} not bidirectional`)
                    return true
                }

                const linkLockResult = linkLock.requestLock(byWhom, fromNodeId)

                // if it failed to lock because of opposing direction
                if (linkLockResult === "CON") {
                    console.debug(`  fail - ${desc} locked against us`)
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
                creator.notifyWaiters(whoCanMoveNow)
            }

            const lockNext = (currentNode: U) => {
                console.warn("lockNext is deprecated, please use arrivedAt")
                const currentIdx = path.findIndex(node => identity(node) === currentNode)
                if (currentIdx === -1) {
                    console.error(`  You're claiming to be at a node not on your path`)
                    console.error(`  Couldnt find "${currentNode}" in ${JSON.stringify(path.map(identity))}`)
                    clearAllPathLocks()
                    return
                }
                arrivedAt(currentIdx)
            }

            const arrivedAt = (currentIdx: number) => {
                debug(`┌─ Lock | ${byWhom} ${currentIdx} ${identity(path[currentIdx])} ──`);
                creator.lastCallCache.set(byWhom, () => arrivedAt(currentIdx))


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
                        const fromNodeId = JSON.stringify(identity(path[i-1]))
                        whoCanMoveNow.addAll(getLockForLink(path[i-1], path[i]).unlock(byWhom, fromNodeId))
                    }

                    // if its behind the firstToLock, unlock it
                    if (i < firstToLock) {
                        whoCanMoveNow.addAll(getLock(path[i]).unlock(byWhom))
                        debug(`unlocked ${identity(path[i])} for ${byWhom}`)
                        continue
                    }

                    const lock = getLock(path[i])
                    if (!creator.isLockGroupAvailable(lock, byWhom)) {
                        debug("Could not obtain lock, group is locked")
                        break;
                    }
                    /* Lock from firstToLock to lastToLock */
                    // if failed to obtain lock, dont try to get any more
                    if (!lock.requestLock(byWhom, JSON.stringify(identity(path[i])))) {
                        break;
                    }
                    debug("  trying to lock bidir edges from node %o", identity(path[i]))
                    // TODO consider returning the length of obtained edge locks
                    // if its > 0, even though further failed, allow the againt to retain the node lock
                    // so we can enter corridors as far as we can and wait there
                    if (!tryLockAllBidirectionalEdges(path.slice(i))) {
                        // unlock previously obtained node lock
                        lock.unlock(byWhom)
                        break
                    }
                    nextNodes.push({node: identity(path[i]), index: i})
                }

                debug({whoCanMoveNow})
                // TODO consider not calling back with same values as last time or leave it up to clients to handle this
                callback(
                    nextNodes,
                    path.length - (currentIdx +1)
                )

                creator.notifyWaiters(whoCanMoveNow)
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
            clearAllLocks: () => creator.clearAllLocks(byWhom)
        }
    }
}

export { makeMakeLocker, Graferse }
export type { Lock, LinkLock, NextNode }
