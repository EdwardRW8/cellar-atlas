# Storage Model

## No universal rack

V2 hard-coded one user's rack as a module constant:

```js
const RACK_COLS = 13;
const COL_HEIGHTS = [4,5,...,16];
```

Every future user would have inherited that rack. In V3 geometry is data.

## The owner's staircase rack becomes one row

```json
{
  "type": "staircase",
  "config": {
    "columns": 13,
    "heights": [4,5,6,7,8,9,10,11,12,13,14,15,16],
    "chamfer": true,
    "orientation": "ascending-right"
  }
}
```

Capacity 130 is derived from `heights.reduce((a,b) => a+b)`, not asserted.

## Layout types

| Type | Positions | Example |
|---|---|---|
| `staircase` | `{col, row}` | The owner's rack |
| `grid` | `{x, y}` | Rectangular rack |
| `shelf` | `{shelf, index}` | Shelving |
| `fridge` | `{shelf, index}` | Wine fridge |
| `unpositioned` | `null` | Floor cases |
| `external` | `null` | Merchant storage |

**Not every location has slots.** Floor cases and merchant storage carry no
geometry, and no code may assume otherwise.

## Contract

Each layout type provides three pure functions:

```ts
capacity(config): number
slotAt(config, position): Slot | null
isValidPosition(config, position): boolean
```

All testable without a renderer.

## Storage names are user data

Berry Bros & Rudd and The Wine Society are **seeded rows for the current
owner**, not universal defaults. Every user creates, renames and deletes
their own locations.
