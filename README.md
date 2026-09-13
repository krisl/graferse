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

### Checking a network

Hand the directed edges to `findLockGroupConflicts` and it reports every
offending pair, with the edges to blame:

```js
const conflicts = creator.findLockGroupConflicts([
    [X, westP], [westP, westQ], [eastQ, eastP],
])
// [{ groups: [[westP, eastP], [westQ, eastQ]],
//    edges:  [[westP, westQ], [eastQ, eastP]] }]
```

An empty result means no two groups are joined in both directions. Run it once
when you build the network, not per traversal.
