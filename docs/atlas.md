# Atlas

## The honest constraint

The brief says do not fake geography. Agreed — so the approach differs by level
according to what data genuinely exists.

| Level | Approach | Why |
|---|---|---|
| **World** | True choropleth, shaded country polygons | Natural Earth 1:110m is public domain |
| **Country** | Proportional symbols at verified region centroids | Region boundaries are not reliably available |
| **Appellation** | Ranked analytical view, no map | No trustworthy free boundary data exists |

Wine-region boundaries are the problem. French appellation boundaries sit with
the INAO and are not uniformly openly licensed. Hand-drawing approximations
would look authoritative while being wrong.

A region drawn as a **circle at a real coordinate** does not claim to be a
territory. Proportional symbol mapping is a legitimate cartographic technique
and it is honest about its own precision.

## Metrics

Bottles · Estimated value · Percentage of cellar · Ready to drink

## Incomplete geography is a feature

Wines missing country or region are surfaced, not hidden:

> 12 wines need geographic information

Tappable, leading to a bulk-fix screen. Atlas works with partial data from the
first bottle.

## Performance

Boundary data is lazy-loaded on first open and never enters the initial bundle.
