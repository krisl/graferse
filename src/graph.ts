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

    return (byWhom: string) => (path: T[]) => {
        if (path.length < 1)
            throw new Error("thats not a path")

        const currentIdx = path.findLastIndex(node => getLock(node).isLocked())
        // if no nodes currently locked, lock the first two
        if (currentIdx === -1) {
            getLock(path[0]).lock(byWhom)
            if (path.length > 1)
                getLock(path[1]).lock(byWhom)

            return
        }

        // else we are traversing the path

        // if there are nodes behind
        if (currentIdx > 0) {
            // TODO assumes lock length of 2
            // if node before me is locked, unlock it
            // else unlock this node because we must be at end of path
            if (getLock(path[currentIdx -1]).isLocked())
                getLock(path[currentIdx -1]).unlock(byWhom)
            else
                getLock(path[currentIdx -0]).unlock(byWhom)
        }

        // if we can lock the next node on our path
        if (currentIdx +1 < path.length) {
            getLock(path[currentIdx +1]).lock(byWhom)
        }
    }
}

export { Lock, makeMakeLocker }
