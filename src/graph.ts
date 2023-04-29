declare global {
    interface Set<T> {
        addAll(s: Set<T> | undefined): void
    }
}

Set.prototype.addAll = function(s) {
    s && s.forEach(item => this.add(item))
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

        console.log(`Resource ${what} is locked, ${byWhom} will wait`)
        this.waiting.add(byWhom)
        return false
    }

    forceLock (byWhom: string) {
        this.lockedBy.add(byWhom)
    }

    unlock (byWhom: string) {
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
}

type LinkLockType = "FREE" | "PRO" | "CON"

class LinkLock {
    private _lock: Lock = new Lock()
    private _direction: any
    readonly isBidirectional: boolean

    constructor(isBidirectional: boolean = false) {
        this.isBidirectional = isBidirectional  // only relevent for edges
    }

    requestLock (byWhom: string, direction: any) {
        if (!this.isBidirectional) {
            console.error("Who is trying to lock a non-bidir link?", {byWhom, direction})
            console.warn("This will cause problems because it should stop locking here")
            return "FREE"
        }

        // already locked by me, just to quieten warning from Lock class intended for nodes
        // ie console.warn("Why are you locking your own node?", {byWhom})
        if (this._lock.isLocked(byWhom)) {
            if (this._direction !== direction)
                throw new Error("Already locked but direction mismatch")
            return "FREE"
        }

        // if its locked by anyone else, in the direction we are going
        if (this._lock.isLocked() && this._direction === direction) {
            this._lock.forceLock(byWhom) // add ourselves to the list
            return "PRO"
        }

        if (this._lock.requestLock(byWhom, "link from " + JSON.stringify(direction))) {
            this._direction = direction
            return "FREE"
        }

        return "CON"
    }

    unlock (byWhom: string) {
        return this._lock.unlock(byWhom)
    }

    isLocked(byWhom?: string) {
        return this._lock.isLocked(byWhom)
    }
}

function makeMakeLocker<T> (
        getLock: (x: T) => Lock,                   // given a T, gives you a Lock
        getLockForLink: (from: T, to: T) => LinkLock,
        identity: (x: T) => any = x => x,          // returns external node identity
        directionIdentity: (x: T) => any = x => x, // returns an identifer representing direction
) {
    const lastCallCache = new Map<string,any>()

    type NextNodes = (nextNodes: T[], remaining: number) => void
    return (path: T[]) => (byWhom: string, callback: NextNodes) => {

        // given an index in the path, tries to lock all bidirectional edges
        // till the last node in the path
        // returns false if first edge fails, otherwise returns true
        // as we can proceed some of the way in the same direction
        function tryLockAllBidirectionalEdges(subpath: T[]) {
            if (subpath.length < 2) {
                return true
            }
            //TODO will these locks and unlocks trigger waiters?
            //may need a cangetlock? function.  prepare lock?
            const linkLock = getLockForLink(subpath[0], subpath[1])
            const desc = `from ${identity(subpath[0])} to ${identity(subpath[1])}`
            if (!linkLock.isBidirectional) {
                console.debug(`  ok - ${desc} not bidirectional`)
                return true
            }

            const linkLockResult = linkLock.requestLock(byWhom, directionIdentity(subpath[0]))

            // if it failed to lock because of opposing direction
            if (linkLockResult === "CON") {
                console.debug(`  fail - ${desc} locked against us`)
                return false
            }

            if (!tryLockAllBidirectionalEdges(subpath.slice(1))) {
                linkLock.unlock(byWhom)
                return false
            }

            console.debug(`  ok - ${desc} obtained`)
            return true
        }

        const lockNext = (currentNode: any) => {
            console.log(`┌─ Lock | ${byWhom} ${currentNode} ──`);
            lastCallCache.set(byWhom, () => lockNext(currentNode))

            const currentIdx = path.findIndex(node => identity(node) === currentNode)
            if (currentIdx === -1) {
                console.error(`  You're claiming to be at a node not on your path`)
                console.error(`  Couldnt find "${currentNode}" in ${JSON.stringify(path.map(identity))}`)
                //FIXME unlock all nodes on the path now
                throw new Error("Wheres your node?")
            }

            const beforeCount = 0, afterCount = 1
            const lastIdx = path.length -1
            const prevIdx = Math.max(currentIdx - beforeCount, 0)      // first to be locked
            const nextIdx = Math.min(currentIdx + afterCount, lastIdx) // last to be locked
            const whoCanMoveNow = new Set<string|undefined>()
            // go through path from start to last node to be locked
            //for (let i = 0; i < prevIdx; i++) {
            //    whoCanMoveNow.add(getLock(path[i]).unlock(byWhom))
            //    if (i > 0)
            //        whoCanMoveNow.add(getLockForLink(path[i-1], path[i]).unlock(byWhom))
            //}
            //for (let i = prevIdx; i <= nextIdx; i++) {
            //}

            for (let i = 0; i <= nextIdx; i++) {
                // unlock all edges before current position
                if (i > 0 && i <= currentIdx)
                    whoCanMoveNow.addAll(getLockForLink(path[i-1], path[i]).unlock(byWhom))

                // if its behind the prevIdx, unlock it
                if (i < prevIdx) {
                    // FIXME
                    // actually these are going to need to unlock when a robot
                    // reports _any_ position in the graph not just on this path!
                    // at least release all previous links in path
                    whoCanMoveNow.addAll(getLock(path[i]).unlock(byWhom))
                    console.log(`unlocked ${identity(path[i])} for ${byWhom}`)
                    continue
                }

                if (i === currentIdx) {
                    getLock(path[i]).forceLock(byWhom)
                    console.log("  trying to lock bidir edge from current node %o", identity(path[i]))
                    if (!tryLockAllBidirectionalEdges(path.slice(i, i+2))) {
                        // failed to obtain lock, dont try to get any more
                        break
                    }

                    continue
                }

                //if (i >= prevIdx) // must be true

                // failed to obtain lock, dont try to get any more
                if (!getLock(path[i]).requestLock(byWhom, JSON.stringify(identity(path[i])))) {
                    break;
                }
                console.log("  trying to lock bidir edges from next node %o", identity(path[i]))
                if (!tryLockAllBidirectionalEdges(path.slice(i))) {
                    // unlock previously obtained node lock
                    getLock(path[i]).unlock(byWhom)
                    break
                }
            }

            console.log({whoCanMoveNow})
            // FIXME dont callback  with same values as last time? or up to clients to handle spurious notifications?
            callback(path.filter(node => getLock(node).isLocked(byWhom)), path.length - (currentIdx +1))

            for (const waiter of whoCanMoveNow) {
                if (waiter) {
                    lastCallCache.get(waiter)()
                }
            }
            console.log('└────\n')
        }

        return {
            lockNext,
            clearAllLocks: () => {
                console.log(`── clearAllLocks | ${byWhom} ──`);
                const whoCanMoveNow = new Set<string|undefined>()
                for (let i = 0; i < path.length; i++) {
                    whoCanMoveNow.addAll(getLock(path[i]).unlock(byWhom))
                    if (i < path.length -1) // expect the last node
                        whoCanMoveNow.addAll(getLockForLink(path[i], path[i+1]).unlock(byWhom))
                }
                for (const waiter of whoCanMoveNow) {
                    if (waiter) {
                        lastCallCache.get(waiter)()
                    }
                }
            },
        }
    }
}

export { Lock, LinkLock, makeMakeLocker }
