# Lock groups

A lock group marks a set of nodes that only one agent may hold at a time,
even when those nodes are not neighbours. Use it where separate nodes share
one piece of physical space, such as two routes crossing a junction.

```js
creator.setLockGroup([westP, eastP])
```

A group therefore behaves like a single node spread over several places.

## Groups joined in both directions deadlock

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

## Solving it with setTopology

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

## Overlapping groups

Exclusion is per group and does **not** spread between groups that share a
node. With groups `[A, B]` and `[B, C]`, an agent holding `A` blocks `B` but
leaves `C` free. The two groups do not merge into one.

`setTopology` reasons about the quotient graph, where contracting the groups
*would* merge them. So its reserve through walk is only exact while groups
stay disjoint. Prefer disjoint groups.
