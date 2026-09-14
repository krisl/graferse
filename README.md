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


## Docs

- [Lock groups](docs/lock-groups.md) — one agent at a time across nodes that
  share physical space, and the deadlock that hides in the quotient graph
- [Notifications](docs/notifications.md) — how a release cascades, and the
  three limits that come with it
- [Prior art](docs/prior-art.md) — railway signalling, MAPF plan execution
  and AGV zone control have each solved this before
