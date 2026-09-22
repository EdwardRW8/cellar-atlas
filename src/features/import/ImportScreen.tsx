import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCellar } from "@/hooks/useCellar";
import {
  parseCsv,
  COLUMNS,
  type ParsedRow,
  type ParseResult,
} from "@/domain/csv-import/parse";
import {
  applyImportIntegrityChecks,
  resolveStatusTargets,
  statusAction,
  type PlannedStatusItem,
} from "@/domain/csv-import/status";
import {
  planAcquisitions,
  summariseAcquisitions,
  importReferencePrefix,
  type PlannedAcquisition,
} from "@/domain/csv-import/acquisitions";
import {
  planImport,
  canConfirm,
  fingerprintCsv,
  stableOperationId,
  type ImportPlan,
  type ExistingLocation,
} from "@/domain/csv-import/plan";
import { buildTemplateCsv, FIELD_GUIDE } from "@/domain/csv-import/template";
import {
  validatePosition,
  type LayoutType,
  type LayoutConfig,
} from "@/domain/storage/layout";
import { Button } from "@/components/Button";
import { TOUCH_TARGET_MIN_PX } from "@/styles/tokens";

/**
 * CSV import.
 *
 * ── NOTHING IS WRITTEN UNTIL CONFIRMED ───────────────────────────────────
 * The file is parsed and validated entirely in the browser. The plan the user
 * approves is the plan that executes, so the preview counts and the result
 * cannot disagree.
 *
 * ── BLOCKING, NOT SKIPPING ───────────────────────────────────────────────
 * A single invalid row blocks the whole import rather than being quietly
 * omitted. The acquisition is ONE transaction, so silently dropping rows
 * would mean importing something different from what was previewed, and the
 * user would have no way to notice. Fixing the file is unambiguous; a partial
 * import that looks complete is not.
 *
 * ── WHAT IS AND IS NOT ATOMIC ────────────────────────────────────────────
 * Atomic:     the acquisition — every bottle and its event, or none.
 * Idempotent: every step, through stable operation ids.
 * NOT atomic: the import as a whole. Valuations, tastings and status changes
 *             are separate mutations that can fail after bottles exist.
 *
 * A retry replays the same ids, so completed steps become no-ops and only the
 * failures re-run. Bottles can never be created twice.
 */

type Stage = "choose" | "preview" | "running" | "done";

/**
 * Each planned item with its row's status, joined by LINE NUMBER — one item
 * per row — never by wine. Two rows of the same wine keep their own statuses.
 */
function plannedStatusItems(
  items: ImportPlan["items"],
  plan: ImportPlan,
  wineIds: Map<string, string>,
): PlannedStatusItem[] {
  const statusByLine = new Map(plan.statusChanges.map((c) => [c.lineNumber, c.status]));
  return items
    .filter((i) => wineIds.has(i.wineKey))
    .map((i) => ({
      lineNumber: i.lineNumber,
      wineId: wineIds.get(i.wineKey)!,
      quantity: i.quantity,
      bottleSize: i.bottleSize,
      unitPrice: i.unitPrice,
      status: statusByLine.get(i.lineNumber) ?? "in_cellar",
    }));
}

interface StepResult {
  label: string;
  attempted: number;
  succeeded: number;
  failures: { line: number | null; error: string }[];
}

export default function ImportScreen() {
  const { repository, run, refresh, locations, bottles } = useCellar();
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  /**
   * Prevents a double-click on Confirm from starting two concurrent imports.
   *
   * The deterministic operation ids would already make the second one
   * harmless, but relying on the database to absorb a UI race is the wrong
   * layer. This stops it at the source; the operation ids remain the
   * backstop.
   */
  const running = useRef(false);

  const [stage, setStage] = useState<Stage>("choose");
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  /** One entry per truthful purchase identity. Held with the plan, so a
   *  retry of THIS attempt reuses the same groups and operation ids. */
  const [groups, setGroups] = useState<PlannedAcquisition[]>([]);
  const [priorImport, setPriorImport] = useState<{ purchasedOn: string | null } | null>(
    null,
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [results, setResults] = useState<StepResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  /** Locations in the shape the planner needs, with real layout validation. */
  const plannerLocations: ExistingLocation[] = useMemo(
    () =>
      locations.map((l) => ({
        id: l.id,
        name: l.name,
        isPositioned: l.isPositioned,
        occupiedKeys: new Set(
          bottles
            .filter((b) => b.isActive && b.storageLocationId === l.id && b.positionKey)
            .map((b) => b.positionKey!),
        ),
        // The location's OWN layout decides validity. Nothing assumes a rack.
        isValidKey: (key: string) => {
          if (!l.isPositioned || !l.layoutType) return false;
          return keyToPosition(l, key) !== null;
        },
      })),
    [locations, bottles],
  );

  const parsePositionKey = useCallback(
    (locationId: string, key: string) => {
      const l = locations.find((x) => x.id === locationId);
      return l ? keyToPosition(l, key) : null;
    },
    [locations],
  );

  const downloadTemplate = () => {
    const blob = new Blob([`\uFEFF${buildTemplateCsv()}`], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cellar-atlas-import-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const onFile = async (file: File) => {
    setError(null);
    setAcknowledged(false);
    setPriorImport(null);
    setFileName(file.name);

    const text = await file.text();
    const raw = parseCsv(text);
    // Rows whose bottles could not be told apart once written, and priced
    // rows in more than one currency, are blocked HERE — before planning — so
    // the preview, the counts and canConfirm all see them.
    const result = { ...raw, rows: applyImportIntegrityChecks(raw.rows) };
    setParsed(result);

    if (result.fatalError) {
      setPlan(null);
      setStage("preview");
      return;
    }

    const fingerprint = await fingerprintCsv(text);

    // A fresh attempt id per upload: stable across retries of THIS attempt,
    // different from a deliberate re-import later.
    const attemptId = crypto.randomUUID();

    const existingWines = repository ? await repository.loadWineIdentities() : [];
    const geography = repository ? await repository.loadGeographyIndex() : new Map();

    // Persistent duplicate protection: survives reload, session and device.
    if (repository) {
      // Every acquisition from this exact file shares one prefix. Detection
      // only — a deliberate later import is still allowed.
      const prior = await repository
        .findPriorImport(importReferencePrefix(fingerprint))
        .catch(() => null);
      if (prior) setPriorImport({ purchasedOn: prior.purchasedOn });
    }

    const nextPlan = await planImport({
      rows: result.rows,
      attemptId,
      fingerprint,
      existingWines,
      geography,
      locations: plannerLocations,
      newId: () => crypto.randomUUID(),
      parsePositionKey,
    });
    setPlan(nextPlan);
    setGroups(
      await planAcquisitions({
        plan: nextPlan,
        rows: result.rows,
        attemptId,
        fileFingerprint: fingerprint,
      }),
    );
    setStage("preview");
  };

  const execute = async () => {
    if (!plan || !repository) return;
    if (running.current) return;
    running.current = true;
    try {
      await executeSteps();
    } catch (e) {
      // Surface rather than swallow, and never leave the user stuck on
      // "Importing" with no way forward.
      setError(e instanceof Error ? e.message : "The import stopped unexpectedly");
      setStage("done");
    } finally {
      // Unconditional: a thrown error must not leave Retry permanently dead.
      running.current = false;
    }
  };

  const executeSteps = async () => {
    if (!plan || !repository) return;
    setStage("running");
    setError(null);

    const steps: StepResult[] = [];
    const wineIds = new Map<string, string>(plan.winesReused.map((w) => [w.key, w.id]));

    // ── 1. Wine definitions ──
    const wineStep: StepResult = {
      label: "Wines created",
      attempted: plan.winesToCreate.length,
      succeeded: 0,
      failures: [],
    };
    for (const w of plan.winesToCreate) {
      const outcome = await run(`Import wine ${w.name}`, (m) =>
        m.createWineDefinition({ operationId: w.operationId, wine: w.wine }),
      );
      if (outcome.ok && outcome.entityId) {
        wineIds.set(w.key, outcome.entityId);
        wineStep.succeeded += 1;
      } else {
        wineStep.failures.push({
          line: w.lineNumbers[0] ?? null,
          error: outcome.error ?? "Could not create this wine",
        });
      }
    }
    steps.push(wineStep);

    // ── 2. Acquisitions: one per truthful purchase identity ──
    //
    // Each group is its OWN atomic transaction: its acquisition, items,
    // bottles and `added` events commit together or not at all. The import
    // as a whole is NOT atomic — one group can succeed while another fails,
    // and the summary reports each.
    const acquisitionIds = new Map<string, string>();
    const acquisitionStep: StepResult = {
      label: "Acquisitions recorded",
      attempted: groups.length,
      succeeded: 0,
      failures: [],
    };
    const bottleStep: StepResult = {
      label: "Bottles created",
      attempted: plan.counts.bottlesToCreate,
      succeeded: 0,
      failures: [],
    };

    for (const g of groups) {
      const items = g.items
        .filter((i) => wineIds.has(i.wineKey))
        .map((i) => ({
          wine_definition_id: wineIds.get(i.wineKey),
          quantity: i.quantity,
          bottle_size: i.bottleSize,
          // NULL stays NULL: an unknown price is never recorded as zero.
          unit_price: i.unitPrice,
          // Per ITEM: rows in one purchase can live in different places.
          storage_location_id: i.storageLocationId,
          positions: i.positions,
        }));

      if (items.length === 0) {
        acquisitionStep.failures.push({
          line: g.lineNumbers[0] ?? null,
          error: "Its wines could not be created, so this purchase was not recorded.",
        });
        continue;
      }

      const outcome = await run(`Import ${fileName}`, (m) =>
        m.createAcquisition({
          // attempt + group: a retry of this attempt replays this exact group.
          operationId: g.operationId,
          acquisition: {
            // Only what the rows actually state. An unknown date or merchant is
            // OMITTED, so the column stays NULL — never the import date, never
            // "CSV import". A group with no priced row has no known currency;
            // the NOT NULL column then takes the RPC default, a label on no
            // money, since every item's unit_price is NULL.
            ...(g.identity.currency ? { currency: g.identity.currency } : {}),
            ...(g.identity.purchasedOn ? { purchased_on: g.identity.purchasedOn } : {}),
            ...(g.identity.merchant ? { source: g.identity.merchant } : {}),
            reference: g.reference,
            notes: `Imported from ${fileName}`,
          },
          items,
        }),
      );

      if (outcome.ok && outcome.entityId) {
        acquisitionIds.set(g.key, outcome.entityId);
        acquisitionStep.succeeded += 1;
        bottleStep.succeeded += items.reduce((n, i) => n + (i.quantity as number), 0);
      } else {
        acquisitionStep.failures.push({
          line: g.lineNumbers[0] ?? null,
          error: outcome.error ?? "This purchase could not be recorded",
        });
      }
    }
    steps.push(acquisitionStep);
    steps.push(bottleStep);

    // ── 3. Valuations ──
    if (plan.valuations.length > 0) {
      const step: StepResult = {
        label: "Valuations recorded",
        attempted: plan.valuations.length,
        succeeded: 0,
        failures: [],
      };
      for (const v of plan.valuations) {
        const wineId = wineIds.get(v.wineKey);
        if (!wineId) continue;
        const outcome = await run(`Import valuation`, (m) =>
          m.recordValuation({
            operationId: v.operationId,
            wineId,
            amount: v.amount,
            currency: v.currency,
            basis: v.basis as never,
            source: v.source as never,
            valuedOn: v.valuedOn ?? undefined,
            // valuation_records.notes is the schema's free-text field: the
            // reference (a URL, a merchant, a sale) is kept there verbatim,
            // labelled, rather than forced into the source-type enum.
            ...(v.reference ? { notes: `Source reference: ${v.reference}` } : {}),
          }),
        );
        if (outcome.ok) step.succeeded += 1;
        else step.failures.push({ line: v.lineNumber, error: outcome.error ?? "Failed" });
      }
      steps.push(step);
    }

    // ── 4. Tastings ──
    if (plan.tastings.length > 0) {
      const step: StepResult = {
        label: "Tastings recorded",
        attempted: plan.tastings.length,
        succeeded: 0,
        failures: [],
      };
      for (const t of plan.tastings) {
        const wineId = wineIds.get(t.wineKey);
        if (!wineId) continue;
        const outcome = await run(`Import tasting`, (m) =>
          m.recordTasting({
            operationId: t.operationId,
            wineId,
            rating: t.rating ?? undefined,
            notes: t.notes ?? undefined,
            tastedOn: t.tastedOn ?? undefined,
            context: t.context ?? undefined,
          }),
        );
        if (outcome.ok) step.succeeded += 1;
        else step.failures.push({ line: t.lineNumber, error: outcome.error ?? "Failed" });
      }
      steps.push(step);
    }

    // ── 5. Status: move Consumed / Removed bottles out of the cellar ──
    //
    // The acquisition returns only its own id. The bottles it created are read
    // back by foreign key, verified against the plan, and each is moved with
    // an operation id derived from the attempt and the bottle — so a retry
    // replays completed moves harmlessly through claim_operation.
    if (plan.statusChanges.length > 0) {
      const step: StepResult = {
        label: "Bottles moved out of the cellar",
        attempted: plan.statusChanges.reduce((n, c) => n + c.quantity, 0),
        succeeded: 0,
        failures: [],
      };

      // Row → group → item → bottles. Each acquisition is read back and
      // verified on its own, so identical items in DIFFERENT acquisitions can
      // never be confused.
      for (const g of groups) {
        const planned = plannedStatusItems(g.items, plan, wineIds);
        if (!planned.some((p) => p.status !== "in_cellar")) continue;

        const acquisitionId = acquisitionIds.get(g.key);
        if (!acquisitionId) {
          step.failures.push({
            line: g.lineNumbers[0] ?? null,
            error: "This purchase was not recorded, so no status could be changed.",
          });
          continue;
        }

        try {
          const created = await repository.loadAcquisitionContents(acquisitionId);
          const resolution = resolveStatusTargets({
            planned,
            created: created.items,
            bottles: created.bottles,
          });

          for (const f of resolution.failures) {
            step.failures.push({ line: f.lineNumbers[0] ?? null, error: f.message });
          }

          for (const t of resolution.targets) {
            const operationId = await stableOperationId(
              plan.attemptId,
              statusAction(t.bottleId),
            );
            const outcome = await run(`Status — line ${t.lineNumbers[0]}`, (m) =>
              m.changeStatus({
                operationId,
                bottleId: t.bottleId,
                version: t.version,
                status: t.status,
                // No status date in the CSV: the import time is recorded.
                ...(t.reason ? { reason: t.reason } : {}),
              }),
            );
            if (outcome.ok) step.succeeded += 1;
            else
              step.failures.push({
                line: t.lineNumbers[0] ?? null,
                error: outcome.error ?? "Failed",
              });
          }
        } catch (e) {
          step.failures.push({
            line: g.lineNumbers[0] ?? null,
            error: e instanceof Error ? e.message : "Could not read the imported bottles",
          });
        }
      }
      steps.push(step);
    }

    setResults(steps);
    await refresh();
    setStage("done");
  };

  // ── RENDER ──────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: "1.25rem" }}>
      <header style={{ marginBottom: "1.25rem" }}>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "1.875rem",
            fontStyle: "italic",
          }}
        >
          Import wines
        </h1>
        <p
          style={{
            fontSize: "0.8125rem",
            color: "var(--text-secondary)",
            marginTop: "0.375rem",
            lineHeight: 1.6,
          }}
        >
          Add many wines at once from a spreadsheet. Nothing is saved until you confirm.
        </p>
      </header>

      {error && (
        <p role="alert" style={alertStyle("var(--status-past)")}>
          {error}
        </p>
      )}

      {stage === "choose" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          <section>
            <h2 style={sectionLabel}>1 · Start from the template</h2>
            <Button variant="secondary" onClick={downloadTemplate}>
              Download CSV template
            </Button>
          </section>

          <section>
            <h2 style={sectionLabel}>2 · Choose your file</h2>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              aria-label="Choose a CSV file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
              style={{
                width: "100%",
                minHeight: TOUCH_TARGET_MIN_PX,
                padding: "0.625rem",
                borderRadius: 10,
                background: "rgba(255,255,255,0.04)",
                border: "1px solid var(--border-strong)",
                color: "var(--text-secondary)",
              }}
            />
          </section>

          <section>
            <h2 style={sectionLabel}>Field guide</h2>
            <dl style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {FIELD_GUIDE.map((f) => (
                <div key={f.field}>
                  <dt style={{ fontSize: "0.8125rem", color: "var(--text-primary)" }}>
                    {f.field}
                  </dt>
                  <dd
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--text-tertiary)",
                      lineHeight: 1.6,
                    }}
                  >
                    {f.guidance}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      )}

      {stage === "preview" && parsed && (
        <Preview
          parsed={parsed}
          plan={plan}
          groups={groups}
          priorImport={priorImport}
          acknowledged={acknowledged}
          onAcknowledge={setAcknowledged}
          onBack={() => {
            setStage("choose");
            if (fileInput.current) fileInput.current.value = "";
          }}
          onConfirm={() => void execute()}
        />
      )}

      {stage === "running" && (
        <p role="status" aria-label="Importing" style={{ color: "var(--text-secondary)" }}>
          Importing…
        </p>
      )}

      {stage === "done" && (
        <Summary
          results={results}
          onDone={() => navigate("/cellar")}
          // Re-runs the SAME plan. Its operation ids are unchanged, so steps
          // that already succeeded replay harmlessly and only failures take
          // effect. This is the only retry path that is genuinely safe.
          onRetry={() => void execute()}
        />
      )}
    </div>
  );
}

function Preview({
  parsed,
  plan,
  groups,
  priorImport,
  acknowledged,
  onAcknowledge,
  onBack,
  onConfirm,
}: {
  parsed: ParseResult;
  plan: ImportPlan | null;
  groups: PlannedAcquisition[];
  priorImport: { purchasedOn: string | null } | null;
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  if (parsed.fatalError) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <p role="alert" style={alertStyle("var(--status-past)")}>
          {parsed.fatalError}
        </p>
        <Button variant="ghost" onClick={onBack}>
          Choose another file
        </Button>
      </div>
    );
  }

  if (!plan) return null;

  const c = plan.counts;
  const blocked = !canConfirm(plan);
  const summary = summariseAcquisitions(groups, parsed.rows);
  const needsAck = c.warningRows > 0 || c.unresolvedPositions > 0 || priorImport !== null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      {priorImport && (
        <p role="alert" style={alertStyle("var(--status-approaching)")}>
          You have imported this exact file before
          {priorImport.purchasedOn ? ` on ${priorImport.purchasedOn.slice(0, 10)}` : ""}.
          Importing it again will add these bottles a second time.
        </p>
      )}

      <section>
        <h2 style={sectionLabel}>What will happen</h2>
        {/* One line per currency. Different currencies are never added. */}
        {summary.costByCurrency.length > 0 && (
          <ul
            aria-label="Purchase cost by currency"
            style={{ listStyle: "none", marginBottom: 8, fontSize: "0.8125rem" }}
          >
            {summary.costByCurrency.map((cc) => (
              <li
                key={cc.currency}
                style={{ display: "flex", justifyContent: "space-between" }}
              >
                <span style={{ color: "var(--text-secondary)" }}>
                  Purchase cost in {cc.currency}
                </span>
                <span style={{ color: "var(--accent-gold)" }}>
                  {cc.currency} {cc.amount.toFixed(2)} · {cc.pricedBottles} bottle
                  {cc.pricedBottles === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        )}
        <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
          <Stat label="Rows read" value={c.rows} />
          <Stat label="Wines to create" value={c.winesToCreate} />
          <Stat label="Existing wines reused" value={c.winesReused} />
          <Stat label="Bottles to create" value={c.bottlesToCreate} />
          <Stat label="Acquisitions to create" value={summary.acquisitions} />
          <Stat
            label="Rows with unknown purchase date"
            value={summary.rowsWithUnknownDate}
          />
          <Stat
            label="Rows with unknown merchant"
            value={summary.rowsWithUnknownMerchant}
          />
          <Stat
            label="Rows with unknown purchase price"
            value={summary.rowsWithUnknownPrice}
          />
          {/* Generic rule: a CSV row is a bottle being brought INTO the
              collection, so a blank status means In cellar. Shown, not hidden. */}
          <Stat
            label="Blank statuses treated as In cellar"
            value={
              parsed.rows.filter(
                (r) => r.severity !== "invalid" && !(r.raw[COLUMNS.status] ?? "").trim(),
              ).length
            }
          />
          <Stat label="Valuations to record" value={c.valuations} />
          <Stat label="Tastings to record" value={c.tastings} />
          {/* Consumed / Removed rows: created, then moved out of the cellar. */}
          <Stat
            label="Bottles leaving the cellar"
            value={plan.statusChanges.reduce((n, s) => n + s.quantity, 0)}
          />
          <Stat
            label="Storage requests that cannot be used"
            value={c.unresolvedPositions}
            warn={c.unresolvedPositions > 0}
          />
          <Stat
            label="Rows that cannot import"
            value={c.invalidRows}
            warn={c.invalidRows > 0}
          />
        </ul>
      </section>

      {parsed.unknownColumns.length > 0 && (
        <p style={noteStyle}>Ignored columns: {parsed.unknownColumns.join(", ")}.</p>
      )}

      {plan.ambiguous.length > 0 && (
        <section>
          <h2 style={sectionLabel}>Possible matches — please check</h2>
          <ul
            style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}
          >
            {plan.ambiguous.map((a) => (
              <li key={a.lineNumber} style={noteStyle}>
                Row {a.lineNumber}: {a.producer} {a.name} — you already have{" "}
                {a.candidates.join(", ")}. A new wine will be created.
              </li>
            ))}
          </ul>
        </section>
      )}

      <RowList rows={parsed.rows} />

      {blocked && (
        <p role="alert" style={alertStyle("var(--status-past)")}>
          {c.invalidRows} row{c.invalidRows === 1 ? "" : "s"} cannot be imported. Correct{" "}
          {c.invalidRows === 1 ? "it" : "them"} in your spreadsheet and choose the file
          again — nothing is imported while any row has an error.
        </p>
      )}

      {!blocked && needsAck && (
        <label
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            fontSize: "0.8125rem",
            color: "var(--text-secondary)",
          }}
        >
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => onAcknowledge(e.target.checked)}
            style={{ minWidth: 20, minHeight: 20, marginTop: 2 }}
          />
          <span>I have read the warnings above and want to import.</span>
        </label>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="ghost" fullWidth onClick={onBack}>
          Back
        </Button>
        <Button
          fullWidth
          disabled={blocked || (needsAck && !acknowledged)}
          onClick={onConfirm}
        >
          Import {c.bottlesToCreate} bottle{c.bottlesToCreate === 1 ? "" : "s"}
        </Button>
      </div>
    </div>
  );
}

function RowList({ rows }: { rows: ParsedRow[] }) {
  const flagged = rows.filter((r) => r.severity !== "valid");
  if (flagged.length === 0) {
    return <p style={noteStyle}>Every row is ready to import.</p>;
  }

  return (
    <section>
      <h2 style={sectionLabel}>Rows needing attention</h2>
      <ul
        style={{
          listStyle: "none",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          maxHeight: 320,
          overflowY: "auto",
        }}
      >
        {flagged.map((r) => (
          <li
            key={r.lineNumber}
            style={{
              padding: "0.625rem 0.875rem",
              borderRadius: 10,
              background: "var(--surface-raised)",
              border: `1px solid ${r.severity === "invalid" ? "rgba(255,138,122,0.35)" : "rgba(245,181,68,0.3)"}`,
            }}
          >
            <div style={{ fontSize: "0.8125rem", color: "var(--text-primary)" }}>
              Row {r.lineNumber}
              {r.producer || r.wineName ? ` · ${r.producer} ${r.wineName}`.trim() : ""}
              <span
                style={{
                  color:
                    r.severity === "invalid"
                      ? "var(--status-past)"
                      : "var(--status-approaching)",
                }}
              >
                {r.severity === "invalid" ? " · cannot import" : " · needs attention"}
              </span>
            </div>
            <ul style={{ listStyle: "none", marginTop: 4 }}>
              {r.issues.map((i, n) => (
                <li
                  key={n}
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--text-tertiary)",
                    lineHeight: 1.6,
                  }}
                >
                  {i.column}: {i.message}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Summary({
  results,
  onDone,
  onRetry,
}: {
  results: StepResult[];
  onDone: () => void;
  onRetry: () => void;
}) {
  const anyFailed = results.some((r) => r.failures.length > 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <h2 style={sectionLabel}>
        {anyFailed ? "Imported with problems" : "Import complete"}
      </h2>

      <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
        {results.map((r) => (
          <li key={r.label}>
            <div style={{ fontSize: "0.875rem", color: "var(--text-primary)" }}>
              {r.label}: {r.succeeded} of {r.attempted}
            </div>
            {r.failures.length > 0 && (
              <ul style={{ listStyle: "none", marginTop: 4 }}>
                {r.failures.slice(0, 5).map((f, i) => (
                  <li
                    key={i}
                    style={{ fontSize: "0.75rem", color: "var(--status-approaching)" }}
                  >
                    {f.line ? `Row ${f.line}: ` : ""}
                    {f.error}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      {anyFailed && (
        <>
          {/*
            The previous wording promised that re-importing the same file would
            retry only what failed. That was FALSE: each upload mints a new
            attempt id, so its operation ids differ and every bottle would be
            created again. The retry guarantee holds only within this screen,
            where the original plan — and its operation ids — still exist.
          */}
          <p style={noteStyle}>
            Retry below to finish what failed. Nothing that already succeeded will be
            created twice.
          </p>
          <p style={{ ...noteStyle, color: "var(--status-approaching)" }}>
            If you leave this screen, this attempt cannot be resumed. Importing the same
            file again would add every bottle a second time.
          </p>
          <Button fullWidth onClick={onRetry}>
            Retry failed steps
          </Button>
        </>
      )}

      <Button fullWidth variant={anyFailed ? "secondary" : "primary"} onClick={onDone}>
        Open the cellar
      </Button>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <li
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        fontSize: "0.8125rem",
      }}
    >
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span style={{ color: warn ? "var(--status-approaching)" : "var(--accent-gold)" }}>
        {value}
      </span>
    </li>
  );
}

/**
 * A canonical position key back into a position object.
 *
 * Validated by the DOMAIN against the location's own layout, so no layout
 * shape is assumed here.
 */
function keyToPosition(
  location: { layoutType: string | null; layoutConfig: unknown },
  key: string,
): Record<string, number> | null {
  if (!location.layoutType) return null;

  const patterns: [RegExp, (m: RegExpExecArray) => Record<string, number>][] = [
    [/^c(\d+)r(\d+)$/i, (m) => ({ col: Number(m[1]), row: Number(m[2]) })],
    [/^x(\d+)y(\d+)$/i, (m) => ({ x: Number(m[1]), y: Number(m[2]) })],
    [/^s(\d+)i(\d+)$/i, (m) => ({ shelf: Number(m[1]), index: Number(m[2]) })],
    [
      /^z(\d+)s(\d+)i(\d+)$/i,
      (m) => ({ zone: Number(m[1]), shelf: Number(m[2]), index: Number(m[3]) }),
    ],
  ];

  for (const [pattern, build] of patterns) {
    const match = pattern.exec(key.trim());
    if (!match) continue;
    const position = build(match);
    const result = validatePosition(
      location.layoutType as LayoutType,
      (location.layoutConfig ?? {}) as LayoutConfig,
      position,
    );
    if (result.valid) return position;
  }

  return null;
}

const sectionLabel: React.CSSProperties = {
  fontSize: "0.6875rem",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--text-tertiary)",
  marginBottom: "0.625rem",
};

const noteStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--text-tertiary)",
  lineHeight: 1.6,
};

const alertStyle = (colour: string): React.CSSProperties => ({
  padding: "0.75rem 1rem",
  borderRadius: 10,
  background: "rgba(255,255,255,0.04)",
  border: `1px solid ${colour}`,
  color: colour,
  fontSize: "0.8125rem",
  lineHeight: 1.6,
});
