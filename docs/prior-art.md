# Prior art

Graferse is not a planner. It takes paths that something else chose and
decides, at run time, who may occupy what and when. That job has been done
before, under three different names.

## Railway signalling

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

## Multi-agent path finding, execution side

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

## AGV zone control and deadlock avoidance

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

## What Graferse does not do

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

## Reading

- [Token (railway signalling)](https://en.wikipedia.org/wiki/Token_(railway_signalling))
- [Absolute permissive block](http://www.lundsten.dk/us_signaling/abs_apb/index.html)
- [Single line operation](http://www.railway-technical.com/signalling/single-line-operation.html)
- [Persistent and Robust Execution of MAPF Schedules in Warehouses](https://ieeexplore.ieee.org/document/8620328/)
- [Bidirectional Temporal Plan Graph](https://arxiv.org/abs/2401.00315)
- [Deadlock prediction and avoidance based on Petri nets for zone-control AGVS](https://www.tandfonline.com/doi/abs/10.1080/00207549508904872)
