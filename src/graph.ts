class Lock {
    lockedBy: string = ""

    constructor() {
        this._unlock()
    }

    lock (byWhom: string) {
        this.lockedBy = byWhom
    }

    unlock (byWhom: string) {
        if (byWhom !== this.lockedBy)
            throw new Error(`tisk tisk ${byWhom} != ${this.lockedBy}`)

        this._unlock()
    }

    private _unlock() {
        this.lockedBy = ""
    }

    isLocked() { return !!this.lockedBy }
}

function makeMakeLocker<T> (getLock: (x: T) => Lock) {

    type NextNodes = (nextNodes: T[]) => void
    return (byWhom: string, path: T[], callback: NextNodes) => (currentNode: T) => {
        const currentIdx = path.findIndex(node => node === currentNode)
        if (currentIdx === -1)
            throw new Error("Wheres your node?")

        // if there are nodes behind
        if (currentIdx > 0) {
            // TODO assumes lock length of 2
            // if node before me is locked, unlock it
            // else unlock this node because we must be at end of path
            if (getLock(path[currentIdx -1]).isLocked())
                getLock(path[currentIdx -1]).unlock(byWhom)
            else {
                getLock(path[currentIdx -0]).unlock(byWhom)
                callback(path.filter(node => getLock(node).isLocked()))
                return
            }
        }

        getLock(path[currentIdx -0]).lock(byWhom)
        // if we can lock the next node on our path
        if (currentIdx +1 < path.length) {
            getLock(path[currentIdx +1]).lock(byWhom)
        }

        callback(path.filter(node => getLock(node).isLocked()))
    }
}

export { Lock, makeMakeLocker }
