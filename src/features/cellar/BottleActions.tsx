import { useState } from "react";
import { useCellar } from "@/hooks/useCellar";
import type { DomainBottle } from "@/domain/types";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { StorageLocationPicker, PositionPicker } from "@/features/storage/StoragePickers";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

type Action =
  | "menu"
  | "move"
  | "deliver"
  | "consume"
  /** Asked BEFORE consuming: would you like to add a tasting first? */
  | "consume-ask-tasting"
  | "gift"
  | "sell"
  | "lost"
  | "remove"
  | "tasting"
  /** Asked AFTER a tasting the user started themselves. */
  | "tasting-ask-consume"
  | "valuation";

/**
 * Why the tasting form is open.
 *
 * This single field is what stops the two workflows chasing each other:
 *
 *   direct           the user chose "Record tasting". Afterwards, offer to
 *                    consume — but only if the bottle can be consumed.
 *   pending-consume  the user chose "Consume" and accepted the offer to add a
 *                    tasting first. Afterwards go STRAIGHT to the consume
 *                    form, because asking "consume this bottle?" when they
 *                    already said so would be absurd.
 *
 * It lives in component state only. Nothing about which prompt the user came
 * through belongs in the database.
 */
type TastingOrigin = "direct" | "pending-consume";

/**
 * Every state-changing action for one PHYSICAL bottle.
 *
 * All ten go through the RPC layer — no direct table writes anywhere. The
 * sheet always names the specific bottle and where it is, so the user is
 * never guessing which one they are acting on (amendment 6).
 */
export function BottleActionSheet({
  bottle,
  wineName,
  onClose,
}: {
  bottle: DomainBottle;
  wineName: string;
  onClose: () => void;
}) {
  const { run, locations, bottles } = useCellar();
  const [action, setAction] = useState<Action>("menu");
  const [tastingOrigin, setTastingOrigin] = useState<TastingOrigin>("direct");
  const [busy, setBusy] = useState(false);

  const location = locations.find((l) => l.id === bottle.storageLocationId) ?? null;

  /**
   * Run a mutation and close on success.
   *
   * Used by every action that ends the workflow.
   */
  const perform = async (label: string, fn: Parameters<typeof run>[1]) => {
    setBusy(true);
    const outcome = await run(label, fn, { bottleId: bottle.id });
    setBusy(false);
    if (outcome.ok) onClose();
  };

  /**
   * Run a mutation and report the result WITHOUT closing, so the caller can
   * decide what happens next.
   *
   * A tasting that is part of a consume workflow must not close the sheet: the
   * consumption still has to happen, and it must remain an explicit decision.
   */
  const attempt = async (
    label: string,
    fn: Parameters<typeof run>[1],
  ): Promise<boolean> => {
    setBusy(true);
    const outcome = await run(label, fn, { bottleId: bottle.id });
    setBusy(false);
    return outcome.ok;
  };

  /**
   * Can this bottle be consumed?
   *
   * Uses the existing domain flag rather than a second list of statuses. A
   * bottle already consumed, gifted, sold, lost or removed is not eligible,
   * and must never be offered the consume prompt.
   */
  const canConsume = bottle.isActive;

  const title = action === "menu" ? wineName : ACTION_TITLES[action];

  return (
    <Sheet open onClose={onClose} title={title}>
      {action === "menu" && (
        <>
          <p
            style={{
              color: "var(--text-tertiary)",
              fontSize: "0.8125rem",
              marginBottom: "1rem",
            }}
          >
            {location ? location.name : "No location"}
            {bottle.position
              ? ` · ${Object.entries(bottle.position)
                  .map(([k, v]) => `${k}${v}`)
                  .join(" ")}`
              : ""}
            {" · "}
            {bottle.bottleSize}
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <ActionButton onClick={() => setAction("consume-ask-tasting")} primary>
              Consume this bottle
            </ActionButton>
            {location?.isExternal && (
              <ActionButton onClick={() => setAction("deliver")}>
                Deliver home from {location.name}
              </ActionButton>
            )}
            <ActionButton onClick={() => setAction("move")}>Move</ActionButton>
            <ActionButton
              onClick={() => {
                setTastingOrigin("direct");
                setAction("tasting");
              }}
            >
              Record tasting
            </ActionButton>
            <ActionButton onClick={() => setAction("valuation")}>
              Record valuation
            </ActionButton>
            <ActionButton onClick={() => setAction("gift")}>Gift</ActionButton>
            <ActionButton onClick={() => setAction("sell")}>Sell</ActionButton>
            <ActionButton onClick={() => setAction("lost")}>
              Mark lost or broken
            </ActionButton>
            <div
              style={{ height: 1, background: "var(--border-subtle)", margin: "0.5rem 0" }}
            />
            <ActionButton onClick={() => setAction("remove")} danger>
              Remove — this record is wrong
            </ActionButton>
          </div>
        </>
      )}

      {(action === "consume" ||
        action === "gift" ||
        action === "sell" ||
        action === "lost") && (
        <StatusForm
          action={action}
          busy={busy}
          onCancel={() => setAction("menu")}
          onConfirm={(date, notes) =>
            perform(`${ACTION_TITLES[action]} — ${wineName}`, (m) =>
              m.changeStatus({
                bottleId: bottle.id,
                version: bottle.version,
                status: STATUS_FOR_ACTION[action],
                occurredAt: date,
                notes,
              }),
            )
          }
        />
      )}

      {action === "remove" && (
        <RemoveForm
          busy={busy}
          onCancel={() => setAction("menu")}
          onConfirm={(reason) =>
            perform(`Remove record — ${wineName}`, (m) =>
              m.changeStatus({
                bottleId: bottle.id,
                version: bottle.version,
                status: "removed",
                reason,
              }),
            )
          }
        />
      )}

      {(action === "move" || action === "deliver") && (
        <MoveForm
          bottle={bottle}
          locations={locations}
          allBottles={bottles}
          isDelivery={action === "deliver"}
          busy={busy}
          onCancel={() => setAction("menu")}
          onConfirm={(locationId, position) =>
            perform(`Move — ${wineName}`, (m) =>
              m.moveBottle({
                bottleId: bottle.id,
                version: bottle.version,
                locationId,
                position,
                isDelivery: action === "deliver",
              }),
            )
          }
        />
      )}

      {/* CONSUME → optional tasting. Asked before anything is committed. */}
      {action === "consume-ask-tasting" && (
        <Decision
          question="Would you like to add a tasting for this bottle?"
          detail="You can record what it was like before it leaves the cellar."
          yesLabel="Yes, add a tasting"
          noLabel="No, just consume"
          onYes={() => {
            // Remember WHY the tasting form is opening, so the reverse
            // prompt is suppressed afterwards.
            setTastingOrigin("pending-consume");
            setAction("tasting");
          }}
          onNo={() => setAction("consume")}
          onCancel={() => setAction("menu")}
        />
      )}

      {action === "tasting" && (
        <TastingForm
          busy={busy}
          bottleName={wineName}
          onCancel={() => {
            // Never consume by abandoning a form. Returning to the decision
            // lets the user consume without a tasting, retry, or back out.
            setAction(tastingOrigin === "pending-consume" ? "consume-ask-tasting" : "menu");
          }}
          onConfirm={async (rating, notes, date, context) => {
            const saved = await attempt(`Tasting — ${wineName}`, (m) =>
              m.recordTasting({
                wineId: bottle.wineDefinitionId,
                bottleId: bottle.id,
                rating,
                notes,
                tastedOn: date,
                context,
              }),
            );

            // A failed tasting must not consume anything. The form stays open
            // with the error the sync layer reported.
            if (!saved) return;

            if (tastingOrigin === "pending-consume") {
              // They already asked to consume. Continue into it directly.
              setAction("consume");
            } else if (canConsume) {
              setAction("tasting-ask-consume");
            } else {
              // Tasting saved, bottle not eligible — nothing more to offer.
              onClose();
            }
          }}
        />
      )}

      {/* TASTING → optional consume. Only for a bottle that can be consumed. */}
      {action === "tasting-ask-consume" && (
        <Decision
          question="Consume this bottle?"
          detail="Your tasting is saved either way."
          yesLabel="Yes, consume it"
          noLabel="No, keep it"
          onYes={() => setAction("consume")}
          // The tasting is already saved; declining simply ends the workflow.
          onNo={onClose}
          onCancel={onClose}
        />
      )}

      {action === "valuation" && (
        <ValuationForm
          busy={busy}
          onCancel={() => setAction("menu")}
          onConfirm={(amount, basis) =>
            perform(`Valuation — ${wineName}`, (m) =>
              m.recordValuation({ bottleId: bottle.id, amount, basis }),
            )
          }
        />
      )}
    </Sheet>
  );
}

/** UI verbs map to database status values. */
const STATUS_FOR_ACTION = {
  consume: "consumed",
  gift: "gifted",
  sell: "sold",
  lost: "lost",
} as const;

const ACTION_TITLES: Record<Action, string> = {
  menu: "Actions",
  move: "Move bottle",
  deliver: "Deliver home",
  consume: "Consume",
  gift: "Gift",
  sell: "Sell",
  lost: "Mark lost",
  remove: "Remove record",
  "consume-ask-tasting": "Before you consume",
  tasting: "Record tasting",
  "tasting-ask-consume": "Tasting saved",
  valuation: "Record valuation",
};

function ActionButton({
  onClick,
  children,
  primary,
  danger,
}: {
  onClick: () => void;
  children: React.ReactNode;
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        textAlign: "left",
        minHeight: TOUCH_TARGET_MIN_PX + 4,
        padding: "0.75rem 1rem",
        borderRadius: 10,
        fontSize: "0.9375rem",
        background: primary
          ? "rgba(217,174,85,0.12)"
          : danger
            ? "rgba(255,138,122,0.08)"
            : "rgba(255,255,255,0.04)",
        border: `1px solid ${
          primary
            ? "rgba(217,174,85,0.35)"
            : danger
              ? "rgba(255,138,122,0.25)"
              : "var(--border-subtle)"
        }`,
        color: primary
          ? "var(--accent-gold)"
          : danger
            ? "var(--status-past)"
            : "var(--text-secondary)",
      }}
    >
      {children}
    </button>
  );
}

function StatusForm({
  action,
  busy,
  onCancel,
  onConfirm,
}: {
  action: "consume" | "gift" | "sell" | "lost";
  busy: boolean;
  onCancel: () => void;
  onConfirm: (date: string, notes: string) => void;
}) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <Field
        label="Date"
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
      <Field
        label="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder={action === "gift" ? "Who received it?" : ""}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="ghost" fullWidth onClick={onCancel}>
          Back
        </Button>
        <Button
          fullWidth
          disabled={busy}
          onClick={() => onConfirm(new Date(date).toISOString(), notes)}
        >
          {busy ? "Saving…" : ACTION_TITLES[action]}
        </Button>
      </div>
    </div>
  );
}

function RemoveForm({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", lineHeight: 1.6 }}>
        Use this only when the record itself is wrong — a duplicate, or a bottle you never
        owned. The record is kept permanently with your reason attached.
      </p>
      <Field
        label="Why is this record wrong?"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Entered twice by mistake"
        required
      />
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="ghost" fullWidth onClick={onCancel}>
          Back
        </Button>
        <Button
          variant="danger"
          fullWidth
          disabled={busy || !reason.trim()}
          onClick={() => onConfirm(reason.trim())}
        >
          {busy ? "Saving…" : "Remove record"}
        </Button>
      </div>
    </div>
  );
}

function MoveForm({
  bottle,
  locations,
  allBottles,
  isDelivery,
  busy,
  onCancel,
  onConfirm,
}: {
  bottle: DomainBottle;
  locations: ReturnType<typeof useCellar>["locations"];
  allBottles: DomainBottle[];
  isDelivery: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (locationId: string, position: Record<string, number> | null) => void;
}) {
  const [locationId, setLocationId] = useState<string | null>(
    isDelivery ? (locations.find((l) => !l.isExternal)?.id ?? null) : null,
  );
  const [position, setPosition] = useState<Record<string, number> | null>(null);

  const target = locations.find((l) => l.id === locationId) ?? null;

  const occupied = new Set(
    allBottles
      .filter(
        (b) =>
          b.isActive &&
          b.id !== bottle.id &&
          b.storageLocationId === locationId &&
          b.positionKey,
      )
      .map((b) => b.positionKey!),
  );

  const ready = locationId !== null && (!target?.isPositioned || position !== null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <StorageLocationPicker
        locations={locations.filter((l) => l.id !== bottle.storageLocationId)}
        value={locationId}
        onChange={(id) => {
          setLocationId(id);
          setPosition(null);
        }}
        allowNone={false}
      />

      {target?.isPositioned && (
        <PositionPicker
          location={target}
          occupiedKeys={occupied}
          positions={[position]}
          onChange={(_, p) => setPosition(p)}
        />
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="ghost" fullWidth onClick={onCancel}>
          Back
        </Button>
        <Button
          fullWidth
          disabled={busy || !ready}
          onClick={() => onConfirm(locationId!, position)}
        >
          {busy ? "Moving…" : isDelivery ? "Deliver home" : "Move"}
        </Button>
      </div>
    </div>
  );
}

function TastingForm({
  busy,
  bottleName,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  bottleName: string;
  onCancel: () => void;
  onConfirm: (
    rating: number | undefined,
    notes: string,
    date: string,
    context: string | undefined,
  ) => void;
}) {
  const [rating, setRating] = useState(0);
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  // Context was already accepted by record_tasting and already editable
  // afterwards — it was simply never offered at creation. Same free-text
  // control and same placeholder as Edit Tasting; no second representation.
  const [context, setContext] = useState("");
  const words = ["", "Disappointing", "Decent", "Very good", "Excellent", "Exceptional"];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div>
        <span
          style={{
            display: "block",
            fontSize: "0.6875rem",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--text-tertiary)",
            marginBottom: "0.5rem",
          }}
        >
          Rating
        </span>
        <div style={{ display: "flex", gap: 4 }} role="radiogroup" aria-label="Rating">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              role="radio"
              aria-checked={rating === n}
              aria-label={`${n} star${n === 1 ? "" : "s"}`}
              onClick={() => setRating(n)}
              style={{
                minWidth: TOUCH_TARGET_MIN_PX,
                minHeight: TOUCH_TARGET_MIN_PX,
                fontSize: "1.5rem",
                lineHeight: 1,
                color: n <= rating ? "var(--accent-gold)" : "var(--border-strong)",
              }}
            >
              ★
            </button>
          ))}
        </div>
        {rating > 0 && (
          <p
            style={{
              fontFamily: "var(--font-display)",
              fontStyle: "italic",
              color: "var(--text-secondary)",
              marginTop: 6,
            }}
          >
            {words[rating]}
          </p>
        )}
      </div>

      <Field
        label="Notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="What did you experience?"
      />
      <Field
        label="Date"
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
      {/* Same control and placeholder as Edit Tasting — one representation. */}
      <Field
        label="Context"
        value={context}
        onChange={(e) => setContext(e.target.value)}
        placeholder="With dinner, at the estate…"
      />

      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="ghost" fullWidth onClick={onCancel}>
          Back
        </Button>
        <Button
          fullWidth
          disabled={busy}
          onClick={() =>
            onConfirm(rating || undefined, notes, date, context.trim() || undefined)
          }
          aria-label={`Save tasting for ${bottleName}`}
        >
          {busy ? "Saving…" : "Save tasting"}
        </Button>
      </div>
    </div>
  );
}

function ValuationForm({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: (
    amount: number,
    basis:
      | "market_estimate"
      | "merchant_retail"
      | "auction_estimate"
      | "realised_sale"
      | "manual_estimate",
  ) => void;
}) {
  const [amount, setAmount] = useState("");
  const [basis, setBasis] = useState<
    | "market_estimate"
    | "merchant_retail"
    | "auction_estimate"
    | "realised_sale"
    | "manual_estimate"
  >("manual_estimate");

  const options: [typeof basis, string][] = [
    ["manual_estimate", "My own estimate"],
    ["market_estimate", "Market estimate"],
    ["merchant_retail", "Merchant price"],
    ["auction_estimate", "Auction estimate"],
    ["realised_sale", "Actually sold for"],
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <Field
        label="Amount (£)"
        type="number"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="120"
      />

      <fieldset style={{ border: "none" }}>
        <legend
          style={{
            fontSize: "0.6875rem",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--text-tertiary)",
            marginBottom: "0.5rem",
          }}
        >
          What kind of figure is this?
        </legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {options.map(([v, l]) => (
            <button
              key={v}
              type="button"
              aria-pressed={basis === v}
              onClick={() => setBasis(v)}
              style={{
                minHeight: TOUCH_TARGET_MIN_PX - 8,
                padding: "0.5rem 0.875rem",
                borderRadius: 999,
                fontSize: "0.8125rem",
                background:
                  basis === v ? "rgba(217,174,85,0.14)" : "rgba(255,255,255,0.04)",
                border: `1px solid ${
                  basis === v ? "rgba(217,174,85,0.4)" : "var(--border-subtle)"
                }`,
                color: basis === v ? "var(--accent-gold)" : "var(--text-secondary)",
              }}
            >
              {l}
            </button>
          ))}
        </div>
      </fieldset>

      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="ghost" fullWidth onClick={onCancel}>
          Back
        </Button>
        <Button
          fullWidth
          disabled={busy || !amount}
          onClick={() => onConfirm(Number(amount), basis)}
        >
          {busy ? "Saving…" : "Save valuation"}
        </Button>
      </div>
    </div>
  );
}

/**
 * An explicit yes/no decision.
 *
 * Consumption is destructive and irreversible in the user's eyes, so it is
 * never inferred from dismissing a sheet: both answers are named buttons, and
 * Cancel is separate from No. `onCancel` returns to a safe state chosen by the
 * caller — it never proceeds.
 */
function Decision({
  question,
  detail,
  yesLabel,
  noLabel,
  onYes,
  onNo,
  onCancel,
}: {
  question: string;
  detail?: string;
  yesLabel: string;
  noLabel: string;
  onYes: () => void;
  onNo: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <p
        role="status"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "1.125rem",
          color: "var(--text-primary)",
          lineHeight: 1.4,
        }}
      >
        {question}
      </p>

      {detail && (
        <p
          style={{
            fontSize: "0.8125rem",
            color: "var(--text-secondary)",
            lineHeight: 1.6,
          }}
        >
          {detail}
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Button fullWidth onClick={onYes}>
          {yesLabel}
        </Button>
        <Button variant="secondary" fullWidth onClick={onNo}>
          {noLabel}
        </Button>
        <Button variant="ghost" fullWidth onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
