# Data Model

## One bottle, one row

`Bottle` has **no quantity field**. Twelve bottles is twelve rows.

This is deliberate. A quantity field cannot express six bottles at home and
six still at the merchant, cannot give each bottle its own history, and drifts
whenever a decrement goes wrong.

The cost lands in the interface, not the database — so bulk operations get
first-class UI. Adding a case must never mean twelve interactions.

Two thousand bottles is two thousand rows. Postgres does not notice this.

## Purchasing — three levels

```
Acquisition          one purchase or order
  date, source, total, reference

AcquisitionItem      one line within it
  acquisition_id →, wine_definition_id →
  quantity, format, unit_price

Bottle               one physical bottle
  acquisition_item_id →  (optional)
```

Three levels rather than two, so a single merchant order containing four
different wines — or a mixed case — models correctly without changing
anything later.

A bottle's link to its acquisition item is optional: wines received as gifts
or already owned before the app existed have no purchase record.

## Entities

| Entity | Represents |
|---|---|
| `WineDefinition` | What the wine *is* — producer, vintage, geography, grapes |
| `Acquisition` | A purchase event |
| `AcquisitionItem` | One wine line within a purchase |
| `Bottle` | One physical bottle |
| `StorageLocation` | A place bottles live |
| `StorageLayout` | Optional visual geometry |
| `BottleEvent` | Immutable ledger entry |
| `TastingRecord` | A tasting, linked to bottle and event |
| `ValuationRecord` | A valuation at a point in time |
| `CellarProfile` | Consumption behaviour and preferences |

## Nothing is ever deleted

There are no `DELETE` policies on domain tables. Removal is a soft update
setting `deleted_at` and a reason. The application is structurally incapable
of destroying a record.

## Purchase price vs current value

Kept separate and never conflated. `ValuationRecord` carries a source and a
confidence, and estimated value is never presented as guaranteed sale value.
