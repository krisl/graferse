class Lock {
    lockedBy: Set<string> = new Set()

    requestLock (byWhom: string) {
        if (!this.isLocked())
            this.forceLock(byWhom)
    }

    forceLock (byWhom: string) {
        this.lockedBy.add(byWhom)
    }

    unlock (byWhom: string) {
        this.lockedBy.delete(byWhom)
    }

    isLocked(byWhom?: string) {
        return byWhom
            ? this.lockedBy.has(byWhom)
            : this.lockedBy.size > 0
    }
}

function makeMakeLocker<T> (getLock: (x: T) => Lock) {

    type NextNodes = (nextNodes: T[]) => void
    return (byWhom: string, path: T[], callback: NextNodes) => (currentNode: T) => {
        const currentIdx = path.findIndex(node => node === currentNode)
        if (currentIdx === -1)
            throw new Error("Wheres your node?")

        const beforeCount = 0, afterCount = 1
        const lastIdx = path.length -1
        const prevIdx = Math.max(currentIdx - beforeCount, 0)      // first to be locked
        const nextIdx = Math.min(currentIdx + afterCount, lastIdx) // last to be locked
        // go through path from start to last node to be locked
        for (let i = 0; i <= nextIdx; i++) {
            // if its behind the prevIdx, unlock it
            if (i < prevIdx)
                getLock(path[i]).unlock(byWhom)
            else
            if (i === currentIdx)
                getLock(path[i]).forceLock(byWhom)
            else
            if (i >= prevIdx)
                getLock(path[i]).requestLock(byWhom)
        }

        callback(path.filter(node => getLock(node).isLocked(byWhom)))
    }
}

export { Lock, makeMakeLocker }
