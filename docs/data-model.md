# Data Model

## One bottle, one row

`bottles` has **no quantity field**. Twelve bottles is twelve rows.

A quantity field cannot express six bottles at home and six at the merchant,
cannot give each bottle its own history or valuation, and drifts whenever a
decrement goes wrong. The cost lands in the interface, not the database — so
bulk operations get first-class UI.

Two thousand bottles is two thousand rows. Postgres does not notice.

## Purchasing — three levels

```
Acquisition        one order        date, source, reference, total
  └─ AcquisitionItem   one line     wine, quantity, format, unit price
       └─ Bottle       one bottle   optional link
```

A merchant order containing four different wines is one acquisition with four
items. A mixed case is the same shape. Purchase metadata is stored **once**
regardless of bottle count.

`Bottle.acquisition_item_id` is nullable — gifts and pre-app stock have no
purchase record. There is deliberately **no price column on `bottles`**: a
second place to store money would eventually disagree with the first.

## Bottles are never deleted

`bottles` has no `deleted_at`. A bottle is historical truth.

`status` covers every real-world outcome: `in_cellar`, `consumed`, `gifted`,
`sold`, `lost`, `removed`. `removed` means a mistaken inventory record, and
**requires a reason** which is written to an immutable event.

## Slot uniqueness uses a canonical key

JSONB cannot enforce this alone — `{"col":1,"row":2}` and `{"row":2,"col":1}`
are different values but the same physical slot.

So every positioned bottle carries `position_key`, a deterministic string
generated **only after** the position has been validated against its layout.
An invalid position has no key and cannot be stored.

```
staircase   c13r16
grid        x2y4
shelving    s3i7
fridge      z1s2i5
unpositioned / external   NULL
```

The unique index is `(storage_location_id, position_key)` where
`status='in_cellar'`. Nulls do not collide, so unlimited bottles coexist in
merchant storage.

## Valuation: basis is separate from source

`source` says **where** the number came from. `valuation_basis` says **what
kind** of number it is.

| Basis | Meaning |
|---|---|
| `market_estimate` | Broad market view |
| `merchant_retail` | A merchant's asking price |
| `auction_estimate` | Pre-sale estimate |
| `realised_sale` | What it **actually** sold for |
| `manual_estimate` | The owner's own judgement |

An auction house's hammer price is `source='auction_house'`,
`basis='realised_sale'`. Conflating the two loses the distinction between an
estimate and a fact.

Purchase price lives on `acquisition_items.unit_price` and never changes.
`valuation_records` is append-only, so value history is preserved and
unrealised gain is computable.

## Geography

A self-referencing hierarchy: country → region → subregion → appellation.

Every row carries **mandatory provenance**: `source`, `source_version`,
`verified_on`, and `centroid_precision`. Nothing is seeded whose origin cannot
be stated.

- Country codes are ISO 3166-1 alpha-2 — a published standard
- Coordinates are hand-curated and marked `approximate` — fit for placing a
  symbol, never presented as boundaries
- `has_boundary` is false throughout; real polygons arrive in Phase 7 for
  countries only, from Natural Earth

Wines point at the most specific node they know. `region_text` holds anything
unmatched, and Atlas reports those as needing attention rather than dropping
them.
