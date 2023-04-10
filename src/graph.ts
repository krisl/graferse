class Lock {
    lockedBy: Set<string> = new Set()
    waiting: Set<string> = new Set()

    requestLock (byWhom: string) {
        if (!this.isLocked()) {
            this.forceLock(byWhom)
            return true
        }

        if (this.isLocked(byWhom)) {
            console.warn("Why are you locking your own node?", {byWhom})
            return true
        }

        console.log(`Node is locked, ${byWhom} is waiting`)
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

function makeMakeLocker<T> (getLock: (x: T) => Lock) {
    const lastCallCache = new Map<string,any>()

    type NextNodes = (nextNodes: T[]) => void
    return (path: T[]) => (byWhom: string, callback: NextNodes) => {

        const lockNext = (currentNode: T) => {
            lastCallCache.set(byWhom, () => lockNext(currentNode))

            const currentIdx = path.findIndex(node => node === currentNode)
            if (currentIdx === -1)
                throw new Error("Wheres your node?")

            const beforeCount = 0, afterCount = 1
            const lastIdx = path.length -1
            const prevIdx = Math.max(currentIdx - beforeCount, 0)      // first to be locked
            const nextIdx = Math.min(currentIdx + afterCount, lastIdx) // last to be locked
            const whoCanMoveNow = new Set<string|undefined>()
            // go through path from start to last node to be locked
            for (let i = 0; i <= nextIdx; i++) {
                // if its behind the prevIdx, unlock it
                if (i < prevIdx)
                    whoCanMoveNow.add(getLock(path[i]).unlock(byWhom))
                else
                    if (i === currentIdx)
                        getLock(path[i]).forceLock(byWhom)
                else
                    if (i >= prevIdx)
                        if (!getLock(path[i]).requestLock(byWhom))
                            // failed to obtain lock, dont try to get any more
                            break;
            }

            callback(path.filter(node => getLock(node).isLocked(byWhom)))

            for (const waiter of whoCanMoveNow) {
                if (waiter) {
                    lastCallCache.get(waiter)()
                }
            }
        }
        return lockNext
    }
}

export { Lock, makeMakeLocker }
