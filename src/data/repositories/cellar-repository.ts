/**
 * Cellar reads and the mappers that turn database rows into domain objects.
 *
 * Reads are direct SELECTs; RLS scopes them to the caller's cellars.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/data/supabase-client";
import { toNumber } from "@/data/schemas";
import type { CellarProfile } from "@/domain/intelligence/types";
import type { HistoryEvent } from "@/domain/history";
import {
  distinctValuationTimestamps,
  mapValuationCurrencies,
  coversAllTimestamps,
  type ValuableBottle,
  type BottleValuation,
  type ValuationLedgerRow,
  type AcquisitionCost,
} from "@/domain/valuation";
import type { TastingRecord } from "@/domain/tasting-log";
import type {
  DomainWine,
  DomainBottle,
  DomainStorageLocation,
  WineSummary,
  GeoPath,
  WineColour,
  BottleStatus,
  BottleSize,
} from "@/domain/types";

export interface GeoRow {
  id: string;
  parent_id: string | null;
  level: string;
  name: string;
  country_code: string;
}

/** Walk a region up to its country, so Atlas and filters can aggregate. */
function buildGeoPath(
  geoRegionId: string | null,
  regionText: string | null,
  index: Map<string, GeoRow>,
): GeoPath {
  const path: GeoPath = {
    country: null,
    region: null,
    appellation: null,
    unmatched: geoRegionId ? null : regionText,
  };
  let node = geoRegionId ? index.get(geoRegionId) : undefined;

  while (node) {
    if (node.level === "country") {
      path.country = { id: node.id, name: node.name, code: node.country_code };
    } else if (node.level === "region") {
      path.region = { id: node.id, name: node.name };
    } else if (node.level === "appellation" || node.level === "subregion") {
      if (!path.appellation) path.appellation = { id: node.id, name: node.name };
    }
    node = node.parent_id ? index.get(node.parent_id) : undefined;
  }
  return path;
}

export class CellarRepository {
  private readonly sb: SupabaseClient;

  constructor(
    private readonly cellarId: string,
    client?: SupabaseClient,
  ) {
    this.sb = client ?? getSupabase();
  }

  /** The cellar the signed-in user belongs to. Creates one on first use. */
  static async resolveCellar(client?: SupabaseClient): Promise<string> {
    const sb = client ?? getSupabase();

    const { data: memberships, error } = await sb
      .from("cellar_members")
      .select("cellar_id")
      .limit(1);
    if (error) throw new Error(error.message);

    if (memberships && memberships.length > 0) {
      return memberships[0]!.cellar_id as string;
    }

    const { data: user } = await sb.auth.getUser();
    if (!user.user) throw new Error("Not signed in");

    const { data: created, error: createError } = await sb
      .from("cellars")
      .insert({ name: "My Cellar", created_by: user.user.id })
      .select("id")
      .single();
    if (createError) throw new Error(createError.message);

    return created.id as string;
  }

  async loadGeographyIndex(): Promise<Map<string, GeoRow>> {
    const { data, error } = await this.sb
      .from("geo_regions")
      .select("id, parent_id, level, name, country_code");
    if (error) throw new Error(error.message);
    return new Map((data ?? []).map((r) => [r.id as string, r as GeoRow]));
  }

  /** Everything the collection screen needs, in three queries. */
  async loadCollection(): Promise<{
    wines: WineSummary[];
    bottles: DomainBottle[];
    locations: DomainStorageLocation[];
  }> {
    const geo = await this.loadGeographyIndex();

    const [wineRes, bottleRes, locRes] = await Promise.all([
      this.sb
        .from("wine_definitions")
        .select("*")
        .eq("cellar_id", this.cellarId)
        .is("deleted_at", null),
      this.sb.from("bottles").select("*").eq("cellar_id", this.cellarId),
      this.sb
        .from("storage_locations")
        .select("*, storage_layouts(id, type, config, capacity)")
        .eq("cellar_id", this.cellarId)
        .is("deleted_at", null)
        .order("sort_order"),
    ]);

    if (wineRes.error) throw new Error(wineRes.error.message);
    if (bottleRes.error) throw new Error(bottleRes.error.message);
    if (locRes.error) throw new Error(locRes.error.message);

    const bottles: DomainBottle[] = (bottleRes.data ?? []).map((b) => ({
      id: b.id,
      wineDefinitionId: b.wine_definition_id,
      acquisitionItemId: b.acquisition_item_id,
      bottleSize: b.bottle_size as BottleSize,
      storageLocationId: b.storage_location_id,
      position: b.position as Record<string, number> | null,
      positionKey: b.position_key,
      status: b.status as BottleStatus,
      statusChangedAt: b.status_changed_at,
      currentValue: toNumber(b.current_value),
      currentValueAt: (b.current_value_at as string | null) ?? null,
      notes: b.notes,
      version: b.version,
      isActive: b.status === "in_cellar",
    }));

    const locations: DomainStorageLocation[] = (locRes.data ?? []).map((l) => {
      const layout = l.storage_layouts as {
        id: string;
        type: string;
        config: Record<string, unknown>;
        capacity: number | null;
      } | null;
      const type = layout?.type ?? null;
      return {
        id: l.id,
        name: l.name,
        kind: l.kind,
        layoutId: layout?.id ?? null,
        layoutType: type,
        layoutConfig: layout?.config ?? null,
        capacity: layout?.capacity ?? null,
        isExternal: l.is_external,
        isPositioned: type !== null && !["unpositioned", "external"].includes(type),
        occupied: bottles.filter((b) => b.isActive && b.storageLocationId === l.id).length,
        version: l.version,
      };
    });

    const locationNames = new Map(locations.map((l) => [l.id, l.name]));

    const wines: WineSummary[] = (wineRes.data ?? []).map((w) => {
      const mine = bottles.filter((b) => b.wineDefinitionId === w.id);
      const active = mine.filter((b) => b.isActive);

      const byLocation = new Map<string, number>();
      for (const b of active) {
        if (!b.storageLocationId) continue;
        byLocation.set(b.storageLocationId, (byLocation.get(b.storageLocationId) ?? 0) + 1);
      }

      const wine: DomainWine = {
        id: w.id,
        producer: w.producer,
        name: w.name,
        vintage: w.vintage,
        colour: w.colour as WineColour | null,
        grapes: w.grapes ?? [],
        geography: buildGeoPath(w.geo_region_id, w.region_text, geo),
        drinkFrom: w.drink_from,
        drinkUntil: w.drink_until,
        notes: w.notes,
        version: w.version,
      };

      const value = active.reduce((sum, b) => sum + (b.currentValue ?? 0), 0);

      return {
        wine,
        activeBottles: active.length,
        totalBottles: mine.length,
        locations: [...byLocation].map(([id, count]) => ({
          id,
          name: locationNames.get(id) ?? "Unknown",
          count,
        })),
        totalValue: value > 0 ? value : null,
        valuation: {
          valuedBottles: active.filter((b) => b.currentValue !== null).length,
          activeBottles: active.length,
        },
      };
    });

    return { wines, bottles, locations };
  }

  async loadEvents(bottleId: string) {
    const { data, error } = await this.sb
      .from("bottle_events")
      .select("*")
      .eq("bottle_id", bottleId)
      .order("occurred_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async loadAcquisitionItem(itemId: string) {
    const { data, error } = await this.sb
      .from("acquisition_items")
      .select("*, acquisitions(*)")
      .eq("id", itemId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }

  async loadValuations(wineId: string, bottleId?: string) {
    let q = this.sb
      .from("valuation_records")
      .select("*")
      .order("valued_on", { ascending: false });
    q = bottleId
      ? q.or(`wine_definition_id.eq.${wineId},bottle_id.eq.${bottleId}`)
      : q.eq("wine_definition_id", wineId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async loadTastings(wineId: string) {
    const { data, error } = await this.sb
      .from("tasting_records")
      .select("*")
      .eq("wine_definition_id", wineId)
      .is("deleted_at", null)
      .order("tasted_on", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /** Type-ahead over the canonical geography hierarchy. */
  async searchGeography(term: string) {
    if (term.trim().length < 2) return [];
    const { data, error } = await this.sb
      .from("geo_regions")
      .select("id, name, level, country_code, parent_id")
      .ilike("name", `%${term.trim()}%`)
      .order("level")
      .limit(20);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /**
   * Has this exact file been imported into this cellar before?
   *
   * The importer stores a content fingerprint in `acquisitions.reference`,
   * which is ordinary RLS-scoped data — no migration, no new column. This
   * makes duplicate protection survive a page reload, a new session and a
   * different device, which an in-memory operation id cannot.
   *
   * A hit is a WARNING, never a block: importing the same wines again is
   * sometimes exactly what the user means.
   */
  /**
   * Has this exact file been imported before?
   *
   * One file now yields several acquisitions, each referenced
   * `import:<fileFingerprint>:<groupFingerprint>`, so detection matches the
   * shared PREFIX. `%` and `_` are escaped because both are LIKE wildcards —
   * the prefix is matched literally. SELECT only, under RLS.
   *
   * This is duplicate-FILE DETECTION, used to warn. It is not idempotency and
   * never blocks: a genuinely repeated purchase must stay possible.
   *
   * Returns the IMPORT time of the earliest match, not a purchase date: the
   * warning is about when the file came in, and a purchase date may be
   * unknown.
   */
  async findPriorImport(
    referencePrefix: string,
  ): Promise<{ id: string; purchasedOn: string | null } | null> {
    const literal = referencePrefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    const { data, error } = await this.sb
      .from("acquisitions")
      .select("id, purchased_on, created_at")
      .eq("cellar_id", this.cellarId)
      .like("reference", `${literal}%`)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) return null;

    return {
      id: data.id as string,
      // The IMPORT time. With one acquisition per purchase, purchased_on is a
      // historical date that may be years old, or unknown — showing it would
      // misstate when this file was imported.
      purchasedOn: (data.created_at as string | null) ?? null,
    };
  }

  /**
   * Every wine definition in the cellar, reduced to its identity.
   *
   * Used to decide reuse versus creation. The fields are exactly those in the
   * database's own uniqueness index, so the importer's notion of "the same
   * wine" cannot drift from the constraint that would reject the insert.
   */
  async loadWineIdentities(): Promise<
    { id: string; producer: string; name: string; vintage: number | null }[]
  > {
    const { data, error } = await this.sb
      .from("wine_definitions")
      .select("id, producer, name, vintage")
      .eq("cellar_id", this.cellarId)
      .is("deleted_at", null);

    if (error) throw new Error(error.message);

    return (data ?? []).map((r) => ({
      id: r.id as string,
      producer: (r.producer as string) ?? "",
      name: (r.name as string) ?? "",
      vintage: toNumber(r.vintage),
    }));
  }

  /**
   * The items and bottles one acquisition created.
   *
   * `create_acquisition_with_items` returns only the acquisition id; item and
   * bottle ids are generated inside it. This reads them back so a CSV import
   * can move the right bottles out of the cellar afterwards.
   *
   * Both reads are keyed on foreign keys — acquisition_id, then
   * acquisition_item_id — never on ordering or timestamps. SELECT only; RLS
   * applies unchanged.
   */
  async loadAcquisitionContents(acquisitionId: string): Promise<{
    items: {
      id: string;
      wineDefinitionId: string;
      quantity: number;
      bottleSize: string;
      unitPrice: string | number | null;
    }[];
    bottles: {
      id: string;
      version: number;
      status: string;
      acquisitionItemId: string;
    }[];
  }> {
    const itemRes = await this.sb
      .from("acquisition_items")
      .select("id, wine_definition_id, quantity, bottle_size, unit_price")
      .eq("acquisition_id", acquisitionId);
    if (itemRes.error) throw new Error(itemRes.error.message);

    const items = (itemRes.data ?? []).map((r) => ({
      id: r.id as string,
      wineDefinitionId: r.wine_definition_id as string,
      quantity: r.quantity as number,
      bottleSize: r.bottle_size as string,
      unitPrice: (r.unit_price as string | number | null) ?? null,
    }));
    if (items.length === 0) return { items, bottles: [] };

    const bottleRes = await this.sb
      .from("bottles")
      .select("id, version, status, acquisition_item_id")
      .in(
        "acquisition_item_id",
        items.map((i) => i.id),
      );
    if (bottleRes.error) throw new Error(bottleRes.error.message);

    return {
      items,
      bottles: (bottleRes.data ?? []).map((r) => ({
        id: r.id as string,
        version: r.version as number,
        status: r.status as string,
        acquisitionItemId: r.acquisition_item_id as string,
      })),
    };
  }

  /**
   * Acquisition cost for every line in the cellar, with its currency.
   *
   * One bulk read. Currency lives on the parent `acquisitions` row —
   * `acquisition_items` has no currency column — so it is joined in here
   * rather than assumed.
   *
   * Purchase price is immutable by design; this only reads it.
   */
  async loadAcquisitionCosts(): Promise<Map<string, AcquisitionCost>> {
    const { data, error } = await this.sb
      .from("acquisition_items")
      .select("id, unit_price, acquisitions(currency)")
      .eq("cellar_id", this.cellarId);

    if (error) throw new Error(error.message);

    return new Map(
      (data ?? []).map((r) => {
        const parent = r.acquisitions as unknown as { currency: string } | null;
        return [
          r.id as string,
          {
            itemId: r.id as string,
            unitPrice: toNumber(r.unit_price),
            // NOT defaulted. An unreadable parent means the currency is
            // unknown, and a cost with an unknown currency must be excluded
            // from totals rather than silently counted as the app default.
            currency: parent?.currency ?? null,
          },
        ];
      }),
    );
  }

  /**
   * The valuation currency behind every bottle's cached value.
   *
   * ── ONE QUERY, NOT N+1 ─────────────────────────────────────────────────
   * Looks up only the DISTINCT `current_value_at` timestamps present on the
   * loaded bottles. That set is bounded by the number of valuation moments
   * still current — typically one per wine — so this is a single bounded read
   * however large the cellar is.
   *
   * ── SELF-HEALING READ ──────────────────────────────────────────────────
   * The primary path filters with `in`. If PostgREST does not round-trip
   * `timestamptz` with full precision, rows go missing SILENTLY and bottles
   * would look unmatched when their data is fine. So coverage is checked, and
   * a miss falls back to a bounded range query with exact client-side
   * matching — the same rule, one extra query, only when needed.
   *
   * Read-only. `valuation_records` is append-only and this never writes.
   */
  async loadValuationCurrencies(bottles: ValuableBottle[]): Promise<{
    valuations: Map<string, BottleValuation>;
    /** Which read path produced the answer. Surfaced for diagnostics. */
    strategy: "in" | "range" | "none";
  }> {
    const timestamps = distinctValuationTimestamps(bottles);
    if (timestamps.length === 0) {
      return {
        valuations: mapValuationCurrencies(bottles, []),
        strategy: "none",
      };
    }

    const columns =
      "id, bottle_id, wine_definition_id, currency, amount, " +
      "valuation_basis, source, created_at";

    // ── Primary: exact timestamp set ──
    const primary = await this.sb
      .from("valuation_records")
      .select(columns)
      .eq("cellar_id", this.cellarId)
      .in("created_at", timestamps);

    if (primary.error) throw new Error(primary.error.message);

    let rows = ((primary.data ?? []) as unknown as Record<string, unknown>[]).map(
      toLedgerRow,
    );

    // ── Fallback: bounded range, matched exactly on the client ──
    if (!coversAllTimestamps(timestamps, rows)) {
      const sorted = [...timestamps].sort();
      const ranged = await this.sb
        .from("valuation_records")
        .select(columns)
        .eq("cellar_id", this.cellarId)
        .gte("created_at", sorted[0]!)
        .lte("created_at", sorted[sorted.length - 1]!);

      if (ranged.error) throw new Error(ranged.error.message);

      // The range is deliberately wide; `rowMatchesBottle` narrows it back to
      // exact equality, so the result is identical to the primary path.
      rows = ((ranged.data ?? []) as unknown as Record<string, unknown>[]).map(toLedgerRow);
      return { valuations: mapValuationCurrencies(bottles, rows), strategy: "range" };
    }

    return { valuations: mapValuationCurrencies(bottles, rows), strategy: "in" };
  }

  /**
   * Cellar-wide history, newest first.
   *
   * Uses the `cellar_history` RPC rather than a client-side join: reading
   * events per bottle cannot answer "what happened last week", and loading
   * every event would not scale. Paginated by `before`, which is the
   * timestamp of the last row already shown.
   *
   * READ ONLY. `bottle_events` has no UPDATE or DELETE policy and this
   * repository offers no path to one.
   */
  async loadHistory(
    opts: {
      limit?: number;
      before?: string | null;
      eventTypes?: string[] | null;
    } = {},
  ): Promise<HistoryEvent[]> {
    const { data, error } = await this.sb.rpc("cellar_history", {
      p_cellar_id: this.cellarId,
      p_limit: opts.limit ?? 50,
      p_before: opts.before ?? null,
      p_event_types: opts.eventTypes?.length ? opts.eventTypes : null,
    });

    if (error) throw new Error(error.message);

    return (data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      bottleId: r.bottle_id as string,
      eventType: r.event_type as string,
      occurredAt: r.occurred_at as string,
      reason: (r.reason as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      wineId: r.wine_id as string,
      producer: (r.producer as string) ?? "",
      wineName: (r.wine_name as string) ?? "",
      vintage: (r.vintage as number | null) ?? null,
      locationName: (r.location_name as string | null) ?? null,
    }));
  }

  /**
   * Every tasting in the cellar, newest first.
   *
   * Includes tastings with a null `bottle_id` — wines tasted elsewhere, which
   * migration 010 explicitly supports.
   */
  async loadAllTastings(): Promise<TastingRecord[]> {
    const { data, error } = await this.sb
      .from("tasting_records")
      .select("*, wine_definitions(id, producer, name, vintage)")
      .eq("cellar_id", this.cellarId)
      .is("deleted_at", null)
      .order("tasted_on", { ascending: false });

    if (error) throw new Error(error.message);

    return (data ?? []).map((r) => {
      const wine = r.wine_definitions as unknown as {
        producer: string;
        name: string;
        vintage: number | null;
      } | null;
      return {
        id: r.id as string,
        wineId: r.wine_definition_id as string,
        bottleId: (r.bottle_id as string | null) ?? null,
        rating: toNumber(r.rating),
        notes: (r.notes as string | null) ?? null,
        tastedOn: r.tasted_on as string,
        context: (r.context as string | null) ?? null,
        version: (r.version as number) ?? 1,
        producer: wine?.producer ?? null,
        wineName: wine?.name ?? null,
        vintage: wine?.vintage ?? null,
      };
    });
  }

  /**
   * The cellar's behavioural profile, or null when none has been saved.
   *
   * Read-only. RLS already restricts reads to cellar members and writes to
   * owners, so no new policy is needed. Every field may be null: migration
   * 011 requires intelligence to degrade gracefully rather than demand a
   * questionnaire.
   */
  async loadCellarProfile(): Promise<CellarProfile | null> {
    const { data, error } = await this.sb
      .from("cellar_profiles")
      .select("*")
      .eq("cellar_id", this.cellarId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) return null;

    return {
      bottlesPerMonth: toNumber(data.bottles_per_month),
      bottlesPurchasedPerYear: toNumber(data.bottles_purchased_per_year),
      typicalPurchaseQuantity: toNumber(data.typical_purchase_quantity),
      prefersAgeing: data.prefers_ageing ?? null,
      collectingHorizonYears: toNumber(data.collecting_horizon_years),
      favouriteGrapes: data.favourite_grapes ?? [],
      dislikes: data.dislikes ?? [],
      typicalBottleBudget: toNumber(data.typical_bottle_budget),
      valuesInvestment: data.values_investment ?? null,
      onboardingCompletedAt: data.onboarding_completed_at ?? null,
      version: data.version ?? 1,
    };
  }

  /**
   * Verified centroids for the canonical geography hierarchy.
   *
   * Atlas needs coordinates and their precision so it can place proportional
   * symbols honestly. Read-only; `geo_regions` has SELECT-only RLS.
   */
  async loadGeoCentroids(): Promise<
    Map<string, { latitude: number | null; longitude: number | null; precision: string }>
  > {
    const { data, error } = await this.sb
      .from("geo_regions")
      .select("id, latitude, longitude, centroid_precision");
    if (error) throw new Error(error.message);

    return new Map(
      (data ?? []).map((r) => [
        r.id as string,
        {
          latitude: r.latitude === null ? null : Number(r.latitude),
          longitude: r.longitude === null ? null : Number(r.longitude),
          precision: (r.centroid_precision as string) ?? "none",
        },
      ]),
    );
  }

  /**
   * Fetch specific geography nodes by id.
   *
   * The picker uses this to show a result's ancestry — "Pauillac · Bordeaux ·
   * France" — so two same-named appellations in different countries are
   * distinguishable.
   */
  async searchGeographyByIds(ids: string[]) {
    if (ids.length === 0) return [];
    const { data, error } = await this.sb
      .from("geo_regions")
      .select("id, name, level, country_code, parent_id")
      .in("id", ids);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /** Current server state for a bottle — used when rebasing a conflict. */
  async fetchBottleState(bottleId: string): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.sb
      .from("bottles")
      .select("*")
      .eq("id", bottleId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data as Record<string, unknown> | null;
  }
}

/** A `valuation_records` row in domain shape. */
function toLedgerRow(r: Record<string, unknown>): ValuationLedgerRow {
  return {
    id: r.id as string,
    bottleId: (r.bottle_id as string | null) ?? null,
    wineDefinitionId: (r.wine_definition_id as string | null) ?? null,
    // NOT defaulted, for the same reason: an unknown currency is unknown.
    currency: (r.currency as string) ?? null,
    amount: Number(r.amount ?? 0),
    valuationBasis: (r.valuation_basis as string) ?? "manual_estimate",
    source: (r.source as string) ?? "manual",
    createdAt: r.created_at as string,
  };
}
