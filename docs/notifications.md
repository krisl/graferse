# Notifications

When an agent releases a lock, every agent freed by it is told to try again by
replaying its last `arrivedAt`. That call may free further waiters, which are
queued and drained by the same release. The whole cascade still runs
**synchronously**, before your call returns.

The queue is drained depth-first: a waiter's own cascade finishes before its
siblings, so the order matches the old recursion (A, then everything A freed,
then B) without growing the stack one frame per agent. A corridor of thousands
of queued agents will not overflow.

Listeners fire **once** when the top-level cascade drains, not once per nested
hop.

Two limits remain:

- agents that keep freeing each other are not detected; only the lock state
  changing at each step ends the cascade
- a listener or callback that does heavy work blocks every agent still queued
  behind it

`notifyWaiters` throws when a waiter has no cached call. That happens if you
took a lock with `requestLock` directly rather than through `arrivedAt`: there
is no way to tell such an agent to retry, and the alternative is a silent
stall. On throw the rest of the queue is dropped; a half-finished cascade is
not resumed on the next release.
