Graferse
========

### Traverses a path through a directed graph, yielding to occupied nodes

Give it your graph and the path each agent means to drive. It tells every
agent how far it may go right now, and tells it again the moment that
changes. Agents never occupy the same place, never meet head on, and never
sit deadlocked waiting on each other.

Written for AGV and robot fleets, but it knows nothing about robots — only
locks, and the callbacks you hand it.

[![Build Status](https://github.com/krisl/graferse/actions/workflows/node.js.yml/badge.svg)](https://github.com/krisl/graferse/actions)
[![Coverage Status](https://coveralls.io/repos/github/krisl/graferse/badge.svg)](https://coveralls.io/github/krisl/graferse)

## Install

```sh
npm install graferse
```

## Use

Make one lock per node, and one per link. A link lock is shared by both
directions when the link is bidirectional.

```js
import { Graferse } from 'graferse'

const creator = new Graferse(nodeId => nodeId)

const nodes = new Map(['a', 'b', 'c', 'd'].map(id => [id, creator.makeLock(id)]))

const links = new Map()
function link(from, to, bidirectional = false) {
    const lock = creator.makeLinkLock(from, to, bidirectional)
    links.set(`${from}>${to}`, lock)
    if (bidirectional) links.set(`${to}>${from}`, lock)
}
link('a', 'b', true)
link('b', 'c', true)
link('c', 'd')
```

Graferse never holds your graph. Tell it how to reach a lock instead:

```js
const makeLocker = creator.makeMakeLocker(
    id => nodes.get(id),
    (from, to) => links.get(`${from}>${to}`),
)
```

Now give an agent its path and a callback. The callback receives how far it
may drive:

```js
const robot = makeLocker('robot-1').makePathLocker(['a', 'b', 'c', 'd'])(
    (allowed, remaining) => {
        console.log(`robot-1 may drive to ${allowed.map(n => n.node).join(', ')}`
                    + ` (${remaining} to go)`)
    })
```

The agent calls `arrivedAt` as it reaches each node of its path. Every call
releases what is behind it and claims what it can ahead:

```js
robot.arrivedAt(0)   // it reports it is at 'a'
robot.arrivedAt(1)   // ... and now at 'b'
```

```
robot-1 may drive to a, b (3 to go)
robot-1 may drive to b, c (2 to go)
```

### Yielding

Put a second agent on the same corridor and it is granted only what is free:

```js
const other = makeLocker('robot-2').makePathLocker(['a', 'b', 'c', 'd'])(
    allowed => {
        console.log(`robot-2 may drive to `
                    + (allowed.map(n => n.node).join(', ') || 'nowhere, waiting'))
    })

other.arrivedAt(0)   // robot-1 still holds 'b'
robot.arrivedAt(2)   // robot-1 moves on to 'c'
```

```
robot-2 may drive to a
robot-1 may drive to c, d (1 to go)
robot-2 may drive to a, b
```

Nobody polled. Releasing `b` woke `robot-2`'s callback on its own.

### Ending a path

```js
robot.clearAllPathLocks()             // left the graph, drop everything
robot.clearAllExceptLastPathLocks()   // idle here, keep only the node it sits on
```

Keeping the last node stops anyone routing through an agent that is parked
on the graph.

## How it decides

Four rules, in the order they apply.

**A node holds one agent.** Everything else follows from that.

**A link is directional.** Agents travelling the same way over a
bidirectional link share it. Agents facing each other cannot, so a head on
meeting is refused before it starts.

**You may not enter a bidirectional run unless you can leave it.** There is
nowhere safe to stop inside one — anywhere you halt, something could be
coming the other way. So the walk reserves ahead until it reaches a one way
link or the end of your path, and refuses entry if it cannot.

**You may join a convoy.** If the only traffic in the way is travelling your
way, you queue behind it rather than being refused: a convoy is one longer
vehicle, and it leaves by the exit its leader already reserved.

That last rule is why a follower trails one node behind a leader instead of
waiting for it to finish. If you want the name for this, it is
[absolute permissive block](docs/prior-art.md).

## Docs

- [Lock groups](docs/lock-groups.md) — one agent at a time across nodes that
  share physical space, and the deadlock that hides in the quotient graph
- [Notifications](docs/notifications.md) — how a release cascades, and the
  three limits that come with it
- [Prior art](docs/prior-art.md) — railway signalling, MAPF plan execution
  and AGV zone control have each solved this before

## Tests

`npm test` or `bun test`
