class Lock {
    lockedBy: Set<string> = new Set()
    waiting: Set<string> = new Set()

    requestLock (byWhom: string, what: string) {
        if (!this.isLocked()) {
            this.forceLock(byWhom)
            return true
        }

        if (this.isLocked(byWhom)) {
            console.warn("Why are you locking your own node?", {byWhom, what})
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
            // dequeue a waiter
            const [waiter] = this.waiting
            this.waiting.delete(waiter)
            return waiter
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

        if (this._lock.requestLock(byWhom, "link from " + JSON.stringify(direction))) {
            this._direction = direction
            return "FREE"
        }

        if (this._direction === direction)
            return "PRO"

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
        // TODO write as recursive function so that everything unlocks if any fail
        function tryLockAllBidirectionalEdges(i: number) {
            console.log("  trying to lock bidir edges from node %o", identity(path[i]))
            // attempt to lock all bidirectional edges in the path
            for(let j = i; j < path.length -1; j++) { // WHY -1??
                const linkLock = getLockForLink(path[j], path[j+1])

                if (!linkLock.isBidirectional)
                    return "FREE"

                const linkLockResult = linkLock.requestLock(byWhom, directionIdentity(path[j]))
                // console.log({linkLockResult})
                // if we cant lock the subsequent edge then stop
                if (linkLockResult !== "FREE") {
                    // if we cant lock the first bidirectional edge, against flow then fail
                    if (linkLockResult === "CON" && j === i) {
                        // console.warn("Failed to lock first link")
                        // unlock the first node, because its next bidir edge failed
                        getLock(path[i]).unlock(byWhom)

                    }
                    return linkLockResult
                }
            }
            return "FREE"
        }

        const lockNext = (currentNode: any) => {
            console.log(`┌─ Lock | ${byWhom} ${currentNode} ──`);
            lastCallCache.set(byWhom, () => lockNext(currentNode))

            const currentIdx = path.findIndex(node => identity(node) === currentNode)
            if (currentIdx === -1) {
                console.error(`  Couldnt find "${currentNode}" in ${JSON.stringify(path)}`)
                throw new Error("Wheres your node?")
            }

            const beforeCount = 0, afterCount = 1
            const lastIdx = path.length -1
            const prevIdx = Math.max(currentIdx - beforeCount, 0)      // first to be locked
            const nextIdx = Math.min(currentIdx + afterCount, lastIdx) // last to be locked
            const whoCanMoveNow = new Set<string|undefined>()
            // go through path from start to last node to be locked
            for (let i = 0; i <= nextIdx; i++) {
                // if its behind the prevIdx, unlock it
                if (i < prevIdx) {
                    // FIXME
                    // actually these are going to need to unlock when a robot
                    // reports _any_ position in the graph not just on this path!
                    // at least release all previous links in path
                    whoCanMoveNow.add(getLock(path[i]).unlock(byWhom))
                    if (i > 0)
                        getLockForLink(path[i-1], path[i]).unlock(byWhom)
                } else
                    if (i === currentIdx) {
                        if (i > 0)
                            getLockForLink(path[i-1], path[i]).unlock(byWhom)
                        getLock(path[i]).forceLock(byWhom)
                        if (tryLockAllBidirectionalEdges(i) === "CON")
                            break
                    }
                else
                    if (i >= prevIdx)
                        if (getLock(path[i]).requestLock(byWhom, JSON.stringify(identity(path[i])))
                            && tryLockAllBidirectionalEdges(i) !== "CON") {
                            //console.log("what happens here")
                        }
                        else
                            // failed to obtain lock, dont try to get any more
                            break;
            }

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
                    whoCanMoveNow.add(getLock(path[i]).unlock(byWhom))
                    if (i < path.length -1)
                        getLockForLink(path[i], path[i+1]).unlock(byWhom)
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
