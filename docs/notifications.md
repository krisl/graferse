# Notifications

When an agent releases a lock, every agent freed by it is told to try again by
replaying its last `arrivedAt`, and that call ends by notifying its own
waiters. A single release therefore runs the whole freed chain
**synchronously**, nested one stack frame deep per agent, before your call
returns.

Three limits follow:

- there is no depth guard, so a long chain of freed agents can reach the stack
  limit
- agents that keep freeing each other are not detected; only the lock state
  changing at each step ends the cascade
- a listener or callback that does heavy work blocks every agent still queued
  behind it

`notifyWaiters` throws when a waiter has no cached call. That happens if you
took a lock with `requestLock` directly rather than through `arrivedAt`: there
is no way to tell such an agent to retry, and the alternative is a silent
stall.
