Graferse
========

### Traverses a path through a directed graph, yielding to occupied nodes

As a traffic coordination system:

  * **Lock Management** - Prevents multiple vehicles from occupying the same road segment simultaneously
  * **Waiting Queues** - Vehicles wait if a road segment is occupied, then are notified when it's free
  * **Link Locks** - Directional and bidirectional locks for modeling road constraints (e.g., one-way streets, intersections)
  * **Lock Groups** - Atomic operations across multiple related resources (useful for intersection coordination)
  * **Agent Notification System** - Vehicles get notified when they can proceed, enabling reactive routing


### Tests

`npm test` or `bun test`

[![Build Status](https://github.com/krisl/graferse/actions/workflows/node.js.yml/badge.svg)](https://github.com/krisl/graferse/actions)
[![Coverage Status](https://coveralls.io/repos/github/krisl/graferse/badge.svg)](https://coveralls.io/github/krisl/graferse)


## Lock groups

A lock group marks a set of nodes that only one agent may hold at a time,
even when those nodes are not neighbours. Use it where separate nodes share
one piece of physical space, such as two routes crossing a junction.

```js
creator.setLockGroup([westP, eastP])
```

A group therefore behaves like a single node spread over several places.

### Groups joined in both directions deadlock

Contract every group down to one node and you get a quotient graph. A pair of
groups joined by edges running in **both** directions becomes a bidirectional
edge there:

```
              group P                     group Q
        +-----------------+         +-----------------+
   X -->|      westP      |-------->|      westQ      |
        |      eastP      |<--------|      eastQ      |
        +-----------------+         +-----------------+

   agent1:  X -> westP -> westQ        enters P, then Q
   agent2:       eastQ -> eastP        enters Q, then P
```

Bidirectional edges are normally safe, because `tryLockAllBidirectionalEdges`
refuses to let an agent in unless it can reserve the whole run through to a
safe state. That protection does not apply here: the real edges are one way,
so nothing sees the corridor.

So `agent2` is granted cell Q while `agent1` already holds cell P. Neither can
reverse, and both sit forever with `X` standing empty behind `agent1`.

Avoiding this is the network builder's job. Graferse never sees your graph,
only locks and a `getLockForLink` callback, so it cannot check on your behalf.

### Solving it with setTopology

Hand Graferse the directed edges once, when you build the network:

```js
const conflicts = creator.setTopology([
    [X, westP], [westP, westQ], [eastQ, eastP],
])
// [{ groups: [[westP, eastP], [westQ, eastQ]],
//    edges:  [[westP, westQ], [eastQ, eastP]] }]
```

Now the reservation walk can see the quotient edge. A one way link is no
longer treated as a safe state when it steps between two such groups, so
`agent2` is refused cell Q while cell P beyond it is taken. It waits outside
instead of being trapped, `agent1` runs the corridor, and both get through.

The return value lists every offending pair with the edges to blame, so
`setTopology` doubles as the check. An empty result means no two groups are
joined in both directions.

To only report and not change traversal, opt out:

```js
creator.setTopology(edges, { reserveThroughLockGroups: false })
```

Then avoiding the deadlock is yours to do. `findLockGroupConflicts(edges)`
reports the same pairs without touching traversal at all.

Graferse still never holds your graph. Without `setTopology` nothing changes.

### Overlapping groups

Exclusion is per group and does **not** spread between groups that share a
node. With groups `[A, B]` and `[B, C]`, an agent holding `A` blocks `B` but
leaves `C` free. The two groups do not merge into one.

`setTopology` reasons about the quotient graph, where contracting the groups
*would* merge them. So its reserve through walk is only exact while groups
stay disjoint. Prefer disjoint groups.

## Notifications

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

## Prior art

Graferse is not a planner. It takes paths that something else chose and
decides, at run time, who may occupy what and when. That job has been done
before, under three different names.

### Railway signalling

The closest match, and the oldest. A bidirectional `LinkLock` is an electric
token instrument: no train may enter single track without the token, and the
token exists once per direction. Token systems also issued more than one
token when several trains needed to follow each other the same way, which is
what lets several same-direction agents co-hold a link lock here.

The convoy rule is **absolute permissive block**. Under APB a single line is
treated as one block against opposing movements, but as a sequence of shorter
blocks for following movements, so a line can hold several trains at once as
long as they all face the same way. Graferse now does exactly that:

```
opposing   reserve the whole bidirectional run to a safe stop
following  one node at a time, queued behind the vehicle ahead
```

Before the convoy rule, the opposing case was applied to everyone, and a
second agent could never join a corridor at all.

If you want vocabulary for this design, start here. The distinctions are well
worn and the writing is free.

### Multi-agent path finding, execution side

Given fixed paths, enforce the order in which nodes are occupied so that any
agent may be delayed arbitrarily without collision. That is the Action
Dependency Graph, from Hönig, Kiesel, Tinka, Durham and Ayanian, *Persistent
and Robust Execution of MAPF Schedules in Warehouses*, IEEE RA-L 4(2), 2019.

One difference matters. An ADG fixes the passing order when the plan is
solved; Graferse fixes it when the lock is taken, first come first served,
with no global plan. So this is closer to a lazy, online ADG. Closing that
gap is live research: the Bidirectional Temporal Plan Graph exists to make
ADG passing orders switchable during execution, which is Graferse's native
mode.

### AGV zone control and deadlock avoidance

The industrial engineering tradition. Zone control — one vehicle per zone —
is the node lock. `tryLockAllBidirectionalEdges` is a safe state check in the
shape of Dijkstra's banker's algorithm, simplified: rather than testing every
agent's maximum claim, it tests only that your own run through to a resting
place is clear.

That family has a known failure mode, and it is the one to watch for here:
such policies reject states that were in fact safe, and cost throughput for
it. Being too restrictive is characteristic, not accidental. The `convoy`
outcome exists to claw back one such case.

The other main branch is Petri nets — see *Deadlock prediction and avoidance
based on Petri nets for zone-control AGVS*, Int. J. Production Research
33(12), 1995.

### What Graferse does not do

Worth stating plainly, because it bounds what you can claim for it.

There is no global schedule and no time windows. Paths arrive one at a time
and are locked greedily, so there is no safety proof over the whole fleet.
Deadlock is avoided structurally — direction claims, plus refusing to enter
what you cannot leave — rather than detected by looking for cycles in a
wait-for graph.

The gap that leaves is circular wait among agents that are all travelling the
same way, on a cycle with no spare capacity. A global banker's check would
catch it. Lock groups and `setTopology` are the nearest tool here, and they
only cover the cases you declare.

### Reading

- [Token (railway signalling)](https://en.wikipedia.org/wiki/Token_(railway_signalling))
- [Absolute permissive block](http://www.lundsten.dk/us_signaling/abs_apb/index.html)
- [Single line operation](http://www.railway-technical.com/signalling/single-line-operation.html)
- [Persistent and Robust Execution of MAPF Schedules in Warehouses](https://ieeexplore.ieee.org/document/8620328/)
- [Bidirectional Temporal Plan Graph](https://arxiv.org/abs/2401.00315)
- [Deadlock prediction and avoidance based on Petri nets for zone-control AGVS](https://www.tandfonline.com/doi/abs/10.1080/00207549508904872)
