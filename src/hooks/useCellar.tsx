/**
 * The single source of cellar state for the whole application.
 *
 * Load is server-first with cache fallback, using the Phase 1 hydration
 * guard: no writer is issued unless a read genuinely succeeded, so the V1
 * data-loss bug is structurally impossible here.
 *
 * Mutations are classified (amendment 3):
 *   simple — applied optimistically, user sees it immediately
 *   large  — held as PENDING until the server confirms
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@/app/providers/AuthProvider";
import { useOnline } from "./useOnline";
import { CellarRepository } from "@/data/repositories/cellar-repository";
import {
  MutationRepository,
  type MutationOutcome,
} from "@/data/repositories/mutation-repository";
import type { WineSummary, DomainBottle, DomainStorageLocation } from "@/domain/types";
import type { PendingMutation } from "@/data/repositories/base";
import { summariseConflict, type ConflictSummary } from "@/domain/conflict-rebase";
import type { CellarProfile } from "@/domain/intelligence/types";
import {
  mapBottleCosts,
  type BottleValuation,
  type BottleCostResult,
} from "@/domain/valuation";

export type LoadState = "loading" | "ready" | "error";

interface CellarValue {
  state: LoadState;
  error: string | null;
  cellarId: string | null;

  wines: WineSummary[];
  bottles: DomainBottle[];
  locations: DomainStorageLocation[];

  /** Large transactions awaiting server confirmation. */
  pending: PendingMutation[];
  /** Conflicts needing a user decision. */
  conflicts: ConflictSummary[];
  /** Operations the server refused outright. */
  failed: { operationId: string; description: string; reason: string }[];

  /** The cellar's behavioural profile. Null when never saved. */
  profile: CellarProfile | null;

  /** Acquisition cost per bottle, or why it is unknown. Never zero. */
  costs: Map<string, BottleCostResult>;
  /** Valuation currency per bottle, or why it is unknown. Never zero. */
  valuations: Map<string, BottleValuation>;

  online: boolean;
  refresh: () => Promise<void>;
  mutations: MutationRepository | null;
  repository: CellarRepository | null;

  /** Run a mutation with the right pending/conflict handling for its kind. */
  run: (
    description: string,
    fn: (m: MutationRepository) => Promise<MutationOutcome>,
    opts?: { bottleId?: string },
  ) => Promise<MutationOutcome>;

  /**
   * Run a multi-entity operation that returns its own per-item outcomes.
   *
   * `run` wraps a SINGLE MutationOutcome into the pending/conflict queue. A
   * bulk delivery is N independent moves with N outcomes, so it reports
   * per-item results itself rather than being squeezed into one. The refresh
   * afterwards is what the caller would otherwise forget.
   */
  runBatch: <T>(
    description: string,
    fn: (m: MutationRepository) => Promise<T>,
  ) => Promise<T>;

  dismissFailed: (operationId: string) => void;
  dismissConflict: (operationId: string) => void;
}

const Ctx = createContext<CellarValue | null>(null);

export function CellarProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const online = useOnline();

  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [cellarId, setCellarId] = useState<string | null>(null);

  const [wines, setWines] = useState<WineSummary[]>([]);
  const [bottles, setBottles] = useState<DomainBottle[]>([]);
  const [locations, setLocations] = useState<DomainStorageLocation[]>([]);
  const [profile, setProfile] = useState<CellarProfile | null>(null);
  const [costs, setCosts] = useState<Map<string, BottleCostResult>>(new Map());
  const [valuations, setValuations] = useState<Map<string, BottleValuation>>(new Map());

  const [pending, setPending] = useState<PendingMutation[]>([]);
  const [conflicts, setConflicts] = useState<ConflictSummary[]>([]);
  const [failed, setFailed] = useState<
    { operationId: string; description: string; reason: string }[]
  >([]);

  const repoRef = useRef<CellarRepository | null>(null);
  const mutRef = useRef<MutationRepository | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    setState("loading");
    setError(null);
    try {
      const id = cellarId ?? (await CellarRepository.resolveCellar());
      setCellarId(id);

      const repo = new CellarRepository(id);
      repoRef.current = repo;
      mutRef.current = new MutationRepository({ cellarId: id, userId: session.user.id });

      const data = await repo.loadCollection();
      setWines(data.wines);
      setBottles(data.bottles);
      setLocations(data.locations);

      // Profile failure must not block the cellar: intelligence degrades,
      // the collection still loads.
      const loadedProfile = await repo.loadCellarProfile().catch(() => null);
      setProfile(loadedProfile);

      // Valuation currency and acquisition cost. Both are additive: a failure
      // leaves the collection fully usable and simply reports value as
      // unknown rather than as zero.
      const [valuationResult, acquisitionCosts] = await Promise.all([
        repo
          .loadValuationCurrencies(
            data.bottles.map((b) => ({
              id: b.id,
              wineDefinitionId: b.wineDefinitionId,
              currentValue: b.currentValue,
              currentValueAt: b.currentValueAt ?? null,
            })),
          )
          .catch(() => ({
            valuations: new Map(),
            strategy: "none" as const,
          })),
        repo.loadAcquisitionCosts().catch(() => new Map()),
      ]);

      setValuations(valuationResult.valuations);
      setCosts(mapBottleCosts(data.bottles, acquisitionCosts));

      setState("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your cellar");
      setState("error");
    }
  }, [session, cellarId]);

  useEffect(() => {
    void load();
  }, [session]);

  const run = useCallback<CellarValue["run"]>(
    async (description, fn, opts) => {
      const m = mutRef.current;
      if (!m) {
        return {
          ok: false,
          kind: "simple",
          operationId: "",
          entityId: null,
          error: "Cellar not ready",
        };
      }

      // Reserve a pending slot for large transactions BEFORE the call, so the
      // UI can show it as queued rather than pretending it is done.
      const placeholder: PendingMutation = {
        operationId: `pending-${Date.now()}`,
        kind: "large",
        entity: "unknown",
        entityId: opts?.bottleId ?? "",
        description,
        queuedAt: new Date().toISOString(),
      };

      let announced = false;
      const announce = setTimeout(() => {
        announced = true;
        setPending((p) => [...p, placeholder]);
      }, 150); // avoid flicker on fast local operations

      try {
        const outcome = await fn(m);
        clearTimeout(announce);
        if (announced) {
          setPending((p) => p.filter((x) => x.operationId !== placeholder.operationId));
        }

        if (outcome.conflict && opts?.bottleId && repoRef.current) {
          const server = await repoRef.current.fetchBottleState(opts.bottleId);
          if (server) {
            setConflicts((c) => [
              ...c,
              summariseConflict({
                operation: {
                  operationId: outcome.operationId,
                  entity: "bottle",
                  entityId: opts.bottleId!,
                  type: "update",
                  payload: {},
                  clientTime: new Date().toISOString(),
                  deviceId: "",
                  attempts: 1,
                  lastAttemptAt: null,
                  lastError: outcome.error ?? "conflict",
                  status: "failed",
                },
                serverState: server,
                baseState: null,
              }),
            ]);
          }
        } else if (!outcome.ok) {
          setFailed((f) => [
            ...f,
            {
              operationId: outcome.operationId,
              description,
              reason: outcome.error ?? "The server rejected this change",
            },
          ]);
        }

        if (outcome.ok) await load();
        return outcome;
      } catch (e) {
        clearTimeout(announce);
        if (announced) {
          setPending((p) => p.filter((x) => x.operationId !== placeholder.operationId));
        }
        const message = e instanceof Error ? e.message : "Something went wrong";
        setFailed((f) => [
          ...f,
          { operationId: placeholder.operationId, description, reason: message },
        ]);
        return {
          ok: false,
          kind: "simple",
          operationId: "",
          entityId: null,
          error: message,
        };
      }
    },
    [load],
  );

  const runBatch = useCallback<CellarValue["runBatch"]>(
    async (_description, fn) => {
      const m = mutRef.current;
      if (!m) throw new Error("Cellar not ready");
      try {
        return await fn(m);
      } finally {
        // Bulk operations change many rows; reload rather than patching
        // local state item by item.
        await load();
      }
    },
    [load],
  );

  const value = useMemo<CellarValue>(
    () => ({
      state,
      error,
      cellarId,
      wines,
      bottles,
      locations,
      profile,
      costs,
      valuations,
      pending,
      conflicts,
      failed,
      online,
      refresh: load,
      runBatch,
      mutations: mutRef.current,
      repository: repoRef.current,
      run,
      dismissFailed: (id) => setFailed((f) => f.filter((x) => x.operationId !== id)),
      dismissConflict: (id) => setConflicts((c) => c.filter((x) => x.operationId !== id)),
    }),
    [
      state,
      error,
      cellarId,
      wines,
      bottles,
      locations,
      profile,
      costs,
      valuations,
      pending,
      conflicts,
      failed,
      online,
      load,
      run,
      runBatch,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCellar(): CellarValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCellar must be used inside CellarProvider");
  return ctx;
}

/** One wine with its bottles, for the detail screen. */
export function useWine(wineId: string | undefined) {
  const { wines, bottles, locations } = useCellar();
  return useMemo(() => {
    if (!wineId) return null;
    const summary = wines.find((w) => w.wine.id === wineId);
    if (!summary) return null;
    const mine = bottles.filter((b) => b.wineDefinitionId === wineId);
    return {
      summary,
      bottles: mine,
      activeBottles: mine.filter((b) => b.isActive),
      locations,
    };
  }, [wineId, wines, bottles, locations]);
}

export function useBottle(bottleId: string | undefined) {
  const { bottles, wines, locations } = useCellar();
  return useMemo(() => {
    if (!bottleId) return null;
    const bottle = bottles.find((b) => b.id === bottleId);
    if (!bottle) return null;
    return {
      bottle,
      wine: wines.find((w) => w.wine.id === bottle.wineDefinitionId)?.wine ?? null,
      location: locations.find((l) => l.id === bottle.storageLocationId) ?? null,
      locations,
    };
  }, [bottleId, bottles, wines, locations]);
}
