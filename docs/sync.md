# Sync & Data Safety

This project has lost a user's collection once. That shapes everything here.

## The two bugs this design prevents

### V1 — write before read

```js
const [wines, setWines] = useState(loadWines);   // load
useEffect(() => saveWines(wines), [wines]);      // fires ON MOUNT
```

The effect ran on first render. If `loadWines()` returned its empty default
for any reason, that empty array was immediately written over the real
collection. The entire cellar was destroyed in milliseconds.

**How V3 prevents it.** `hydrate()` returns a `CacheWriter` *only* when it has
obtained trustworthy data from the server or a valid cache. If both fail, no
writer is issued and writing is not an available operation. The guard is
structural, not a flag someone must remember to check.

Covered by `tests/unit/cache.test.ts`.

### V2 — queue clobbering

```js
const pending = readQueue();          // snapshot
for (const op of pending) { await network(); }   // seconds pass
setQueue(remaining);                  // overwrites concurrent edits
```

An edit made during a sync was silently destroyed.

**How V3 prevents it.** Acknowledgement is by ID:

```ts
await queue.removeByIds(acknowledged);
```

Nothing replaces the queue wholesale. Anything enqueued mid-flush survives
because it was never in the acknowledged set.

Covered by `tests/unit/sync.test.ts` — and verified by mutation testing:
reintroducing the V2 implementation causes six tests to fail.

## Idempotency

Every operation carries an `operationId` distinct from the entity id. The
server records applied operation ids in `applied_operations`. A replay hits
the primary key, returns `duplicate`, and the client treats that as success.

This matters because a lost response on a flaky mobile connection is
indistinguishable from a failure. Without idempotency the retry conflicts,
throws, and jams the queue permanently — which is what V2 did.

## Failure handling

| Outcome | Meaning | Action |
|---|---|---|
| `applied` | Succeeded | Remove from queue |
| `duplicate` | Already applied | Remove from queue — this is success |
| `retryable` | Network, timeout, 5xx | Keep, exponential backoff |
| `conflict` | Version mismatch | Park for resolution |
| `permanent` | Invalid data, RLS denial | Park for review |

**A parked operation is never discarded.** It represents work the user did.
`retryFailed()` re-arms them.

## Storage

The queue lives in **IndexedDB**, not localStorage. localStorage is capped
around 5 MB and browsers may clear it under storage pressure without warning.
For the one structure whose loss means losing user edits, that is not
acceptable.

The cache is schema-versioned. A mismatch discards it rather than reading a
stale shape incorrectly.
