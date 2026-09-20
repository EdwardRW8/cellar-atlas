import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCellar } from "@/hooks/useCellar";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { EmptyState } from "@/components/EmptyState";
import type { LayoutConfig, LayoutType } from "@/domain/storage/layout";
import { capacity } from "@/domain/storage/layout";
import { computeOccupancy } from "@/domain/storage/occupancy";
import type { DomainStorageLocation } from "@/domain/types";
import { Skeleton } from "@/components/Skeleton";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

/**
 * Storage locations.
 *
 * Lists and pickers only — graphical rack rendering is Phase 5. Nothing here
 * assumes a rack exists, or that any particular layout type is present.
 */
/** Occupancy derived from whatever layout the location happens to have. */
function occupancyFor(l: DomainStorageLocation) {
  return computeOccupancy(
    l.occupied,
    l.layoutType as LayoutType | null,
    l.layoutConfig as LayoutConfig | null,
  );
}

export default function StorageScreen() {
  const { state, locations, run } = useCellar();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  if (state === "loading") {
    return (
      <div style={{ padding: "1.25rem" }}>
        <Skeleton rows={3} />
      </div>
    );
  }

  return (
    <div style={{ padding: "1rem 1rem 2rem" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "1.25rem",
        }}
      >
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "1.875rem",
            fontStyle: "italic",
          }}
        >
          Storage
        </h1>
        <Button onClick={() => setCreating(true)}>Add</Button>
      </header>

      {locations.length === 0 ? (
        <EmptyState
          title="No storage locations yet"
          description="A rack is entirely optional. Merchant storage, floor cases, or no location at all are all perfectly valid."
          action={<Button onClick={() => setCreating(true)}>Create a location</Button>}
        />
      ) : (
        <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
          {locations.map((l) => (
            <li key={l.id}>
              <button
                onClick={() => navigate(`/storage/${l.id}`)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  minHeight: TOUCH_TARGET_MIN_PX + 16,
                  padding: "0.875rem 1rem",
                  borderRadius: 12,
                  background: "var(--surface-raised)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontSize: "1rem", color: "var(--text-primary)" }}>
                    {l.name}
                  </span>
                  <span
                    style={{
                      fontSize: "0.875rem",
                      color: occupancyFor(l).isFull
                        ? "var(--status-approaching)"
                        : "var(--accent-gold)",
                    }}
                  >
                    {occupancyFor(l).label}
                  </span>
                </span>
                <span
                  style={{
                    display: "block",
                    fontSize: "0.75rem",
                    color: "var(--text-tertiary)",
                    marginTop: 2,
                  }}
                >
                  {l.isExternal ? "External" : l.kind}
                  {l.layoutType ? ` · ${l.layoutType}` : " · no layout"}
                  {!l.isPositioned ? " · unpositioned" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Sheet
        open={creating}
        onClose={() => setCreating(false)}
        title="New storage location"
      >
        <CreateLocationForm
          onCancel={() => setCreating(false)}
          onCreate={async (name, kind, isExternal, layout) => {
            let layoutId: string | null = null;
            if (layout) {
              const r = await run(`Create layout ${name}`, (m) =>
                m.createLayout({ name, type: layout.type, config: layout.config }),
              );
              if (!r.ok) return;
              layoutId = r.entityId;
            }
            const r = await run(`Create location ${name}`, (m) =>
              m.createLocation({ name, kind, layoutId, isExternal }),
            );
            if (r.ok) setCreating(false);
          }}
        />
      </Sheet>
    </div>
  );
}

type LayoutChoice =
  | {
      type: "staircase";
      config: {
        columns: number;
        heights: number[];
        chamfer: boolean;
        orientation: "ascending-right" | "ascending-left";
      };
    }
  | { type: "grid"; config: { rows: number; columns: number } }
  | { type: "shelving"; config: { shelves: number[] } }
  | {
      type: "fridge";
      config: { zones: { name: string; shelves: number; perShelf: number }[] };
    }
  | null;

/**
 * Layout choices are offered generically. No option is privileged, and a
 * location with no layout at all is a first-class choice.
 */
function CreateLocationForm({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (
    name: string,
    kind: "home" | "merchant" | "fridge" | "other",
    isExternal: boolean,
    layout: LayoutChoice,
  ) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"home" | "merchant" | "fridge" | "other">("home");
  const [shape, setShape] = useState<"none" | "staircase" | "grid" | "shelving" | "fridge">(
    "none",
  );
  const [rows, setRows] = useState("6");
  const [columns, setColumns] = useState("12");
  const [shelves, setShelves] = useState("4");
  const [perShelf, setPerShelf] = useState("10");

  // Staircase: entered as a pattern rather than drawn. A graphical designer
  // is Phase 5; this only has to produce a valid config.
  const [stairColumns, setStairColumns] = useState("13");
  const [stairFirst, setStairFirst] = useState("4");
  const [stairStep, setStairStep] = useState("1");
  const [stairChamfer, setStairChamfer] = useState(true);
  const [stairOrientation, setStairOrientation] = useState<
    "ascending-right" | "ascending-left"
  >("ascending-right");

  const isExternal = kind === "merchant";

  /**
   * Heights from a first-column count and a per-column step.
   *
   * 13 columns starting at 4, stepping by 1, gives [4..16] — capacity 130.
   * Nothing here is specific to that: the numbers come from the form, and
   * capacity is derived by the domain.
   */
  const staircaseHeights = (): number[] => {
    const n = Math.max(1, Number(stairColumns) || 1);
    const first = Math.max(1, Number(stairFirst) || 1);
    const step = Number(stairStep) || 0;
    return Array.from({ length: n }, (_, i) => Math.max(1, first + i * step));
  };

  const build = (): LayoutChoice => {
    if (shape === "staircase") {
      return {
        type: "staircase",
        config: {
          columns: Math.max(1, Number(stairColumns) || 1),
          heights: staircaseHeights(),
          chamfer: stairChamfer,
          orientation: stairOrientation,
        },
      };
    }
    if (shape === "grid") {
      return { type: "grid", config: { rows: Number(rows), columns: Number(columns) } };
    }
    if (shape === "shelving") {
      return {
        type: "shelving",
        config: {
          shelves: Array.from({ length: Number(shelves) }, () => Number(perShelf)),
        },
      };
    }
    if (shape === "fridge") {
      return {
        type: "fridge",
        config: {
          zones: [{ name: "Main", shelves: Number(shelves), perShelf: Number(perShelf) }],
        },
      };
    }
    return null;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <Field
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Home Cellar"
        autoFocus
      />

      <fieldset style={{ border: "none" }}>
        <legend style={legend}>Kind</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {(["home", "merchant", "fridge", "other"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              style={chip(kind === k)}
            >
              {k}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset style={{ border: "none" }}>
        <legend style={legend}>Layout</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {(
            [
              ["none", "No fixed positions"],
              ["staircase", "Staircase rack"],
              ["grid", "Grid rack"],
              ["shelving", "Shelving"],
              ["fridge", "Wine fridge"],
            ] as const
          ).map(([v, l]) => (
            <button
              key={v}
              type="button"
              onClick={() => setShape(v)}
              aria-pressed={shape === v}
              style={chip(shape === v)}
            >
              {l}
            </button>
          ))}
        </div>
      </fieldset>

      {shape === "staircase" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <Field
              label="Columns"
              type="number"
              inputMode="numeric"
              value={stairColumns}
              onChange={(e) => setStairColumns(e.target.value)}
            />
            <Field
              label="First column holds"
              type="number"
              inputMode="numeric"
              value={stairFirst}
              onChange={(e) => setStairFirst(e.target.value)}
            />
            <Field
              label="Increase by"
              type="number"
              inputMode="numeric"
              value={stairStep}
              onChange={(e) => setStairStep(e.target.value)}
              hint="Per column"
            />
          </div>

          <fieldset style={{ border: "none" }}>
            <legend style={legend}>Orientation</legend>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {(
                [
                  ["ascending-right", "Tallest on the right"],
                  ["ascending-left", "Tallest on the left"],
                ] as const
              ).map(([v, l]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setStairOrientation(v)}
                  aria-pressed={stairOrientation === v}
                  style={chip(stairOrientation === v)}
                >
                  {l}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setStairChamfer(!stairChamfer)}
                aria-pressed={stairChamfer}
                style={chip(stairChamfer)}
              >
                Chamfered top
              </button>
            </div>
          </fieldset>

          <StaircasePreview heights={staircaseHeights()} />
        </div>
      )}

      {shape === "grid" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field
            label="Rows"
            type="number"
            value={rows}
            onChange={(e) => setRows(e.target.value)}
          />
          <Field
            label="Columns"
            type="number"
            value={columns}
            onChange={(e) => setColumns(e.target.value)}
          />
        </div>
      )}

      {(shape === "shelving" || shape === "fridge") && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field
            label="Shelves"
            type="number"
            value={shelves}
            onChange={(e) => setShelves(e.target.value)}
          />
          <Field
            label="Bottles per shelf"
            type="number"
            value={perShelf}
            onChange={(e) => setPerShelf(e.target.value)}
          />
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="ghost" fullWidth onClick={onCancel}>
          Cancel
        </Button>
        <Button
          fullWidth
          disabled={!name.trim()}
          onClick={() => onCreate(name.trim(), kind, isExternal, build())}
        >
          Create
        </Button>
      </div>
    </div>
  );
}

/**
 * Live preview of the entered geometry.
 *
 * Capacity comes from `capacity()` in the domain — the same function the
 * database mirrors. No number is hard-coded, so this is correct for any
 * staircase a user describes, not one particular rack.
 */
function StaircasePreview({ heights }: { heights: number[] }) {
  const total = capacity("staircase", {
    columns: heights.length,
    heights,
    chamfer: false,
    orientation: "ascending-right",
  });

  return (
    <div
      style={{
        padding: "0.75rem 0.875rem",
        borderRadius: 10,
        background: "rgba(217,174,85,0.06)",
        border: "1px solid rgba(217,174,85,0.2)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "1.25rem",
          color: "var(--accent-gold)",
        }}
      >
        {total} bottles
      </div>
      <div
        style={{
          fontSize: "0.6875rem",
          color: "var(--text-tertiary)",
          marginTop: 4,
          wordBreak: "break-word",
        }}
      >
        {heights.length} column{heights.length === 1 ? "" : "s"} · {heights.join(", ")}
      </div>
    </div>
  );
}

const legend: React.CSSProperties = {
  fontSize: "0.6875rem",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--text-tertiary)",
  marginBottom: "0.5rem",
};

function chip(selected: boolean): React.CSSProperties {
  return {
    minHeight: TOUCH_TARGET_MIN_PX - 8,
    padding: "0.5rem 0.875rem",
    borderRadius: 999,
    fontSize: "0.8125rem",
    textTransform: "capitalize",
    background: selected ? "rgba(217,174,85,0.14)" : "rgba(255,255,255,0.04)",
    border: `1px solid ${selected ? "rgba(217,174,85,0.4)" : "var(--border-subtle)"}`,
    color: selected ? "var(--accent-gold)" : "var(--text-secondary)",
  };
}
