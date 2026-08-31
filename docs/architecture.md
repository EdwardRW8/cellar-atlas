# Architecture

## The rule that matters

**`src/domain/` may not import React.**

Everything in it is a pure function testable without a renderer: drinking
window states, rack capacity, pairing scores, collection health. This is what
makes the intelligence features verifiable rather than mysterious — a
recommendation that cannot be unit-tested is a guess with confident styling.

## Layers

```
features/    screens and UI
    ↓
hooks/       React bindings
    ↓
data/        repositories, sync, cache
    ↓
domain/      pure logic — NO React
```

Dependencies point downward only.

## Why not V2's single file

V2 was one 116 KB file compiled by hand. It worked, but:

- no type safety — a field rename failed silently at runtime
- no tests — every regression was found by the user in production
- `useCellarData` held load, cache, queue, sync and all mutations, untested
- one component held 435 lines of tab, filter and modal state
- a throw in the rack renderer blanked the whole application

## Error isolation

Every route is wrapped in its own boundary. A failure in Atlas leaves the
Cellar fully usable. Heavy visualisations get a second inner boundary so a
rendering error cannot take down the screen around it.

## Code splitting

Routes are lazy-loaded. The rack renderer and Atlas geography never enter the
initial bundle — they load when opened.

Current build:

| Chunk | Gzipped |
|---|---|
| React vendor | 67 KB |
| Supabase | 57 KB |
| App shell | 5.6 KB |
| Each route | under 1 KB |
