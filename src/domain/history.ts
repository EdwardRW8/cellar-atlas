/**
 * Cellar history.
 *
 * ── READ-ONLY BY CONSTRUCTION ────────────────────────────────────────────
 * `bottle_events` is an append-only ledger with no UPDATE or DELETE policy.
 * Nothing in this module produces a mutation, and nothing that consumes it
 * may offer one. History is a record of what happened; it is not editable,
 * and the UI must never imply otherwise.
 *
 * ── PLAIN LANGUAGE ───────────────────────────────────────────────────────
 * An event row says `event_type: 'moved'`. A person wants "Moved to Home
 * Cellar". Every one of the twelve event types gets a sentence, and an
 * unrecognised type degrades to something readable rather than throwing —
 * a future migration may add a type this build has never seen.
 */

export const EVENT_TYPES = [
  "acquired",
  "added",
  "moved",
  "delivered",
  "consumed",
  "gifted",
  "sold",
  "lost",
  "removed",
  "valued",
  "tasting_recorded",
  "corrected",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface HistoryEvent {
  id: string;
  bottleId: string;
  eventType: string;
  occurredAt: string;
  reason: string | null;
  notes: string | null;
  wineId: string;
  producer: string;
  wineName: string;
  vintage: number | null;
  locationName: string | null;
}

export interface HistoryDay {
  /** ISO date, YYYY-MM-DD. */
  date: string;
  label: string;
  events: HistoryEvent[];
}

/** Types offered as filters, with readable labels. */
export const EVENT_FILTERS: { type: EventType; label: string }[] = [
  { type: "added", label: "Added" },
  { type: "moved", label: "Moved" },
  { type: "delivered", label: "Delivered" },
  { type: "consumed", label: "Consumed" },
  { type: "gifted", label: "Gifted" },
  { type: "sold", label: "Sold" },
  { type: "lost", label: "Lost" },
  { type: "tasting_recorded", label: "Tasted" },
  { type: "valued", label: "Valued" },
  { type: "corrected", label: "Corrected" },
];

/**
 * One event, in plain English.
 *
 * Location is included where it is meaningful — a move without a destination
 * tells the reader nothing useful.
 */
export function describeEvent(e: HistoryEvent): string {
  const where = e.locationName ? ` to ${e.locationName}` : "";

  switch (e.eventType) {
    case "acquired":
      return "Acquired";
    case "added":
      return e.locationName ? `Added to ${e.locationName}` : "Added to the cellar";
    case "moved":
      return `Moved${where}`;
    case "delivered":
      return e.locationName ? `Delivered to ${e.locationName}` : "Delivered";
    case "consumed":
      return "Consumed";
    case "gifted":
      return "Gifted";
    case "sold":
      return "Sold";
    case "lost":
      return "Recorded as lost";
    case "removed":
      return "Record removed";
    case "valued":
      return "Valuation recorded";
    case "tasting_recorded":
      return "Tasting recorded";
    case "corrected":
      return "Record corrected";
    default:
      // A migration may add a type this build has not seen. Read it out
      // rather than throwing or showing a raw identifier.
      return e.eventType.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  }
}

/** The wine an event concerns, as a person would name it. */
export function describeWine(e: HistoryEvent): string {
  return `${e.wineName}${e.vintage ? ` ${e.vintage}` : ""}`;
}

function isoDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/**
 * A day label relative to today: Today, Yesterday, or a written date.
 *
 * `now` is injected so tests are deterministic and do not break at midnight.
 */
export function describeDay(date: string, now: Date = new Date()): string {
  const today = isoDate(now.toISOString());
  const yesterday = isoDate(new Date(now.getTime() - 86_400_000).toISOString());

  if (date === today) return "Today";
  if (date === yesterday) return "Yesterday";

  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;

  const sameYear = parsed.getUTCFullYear() === now.getUTCFullYear();
  return parsed.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

/**
 * Group events into days, newest first.
 *
 * Grouping uses `occurred_at` — when the thing actually happened — not
 * `created_at`. Migration 009 makes that distinction deliberately: you might
 * log on Tuesday a bottle drunk on Saturday, and the history should say
 * Saturday.
 */
export function groupByDay(events: HistoryEvent[], now: Date = new Date()): HistoryDay[] {
  const days = new Map<string, HistoryEvent[]>();

  for (const e of events) {
    if (!e.occurredAt) continue;
    const date = isoDate(e.occurredAt);
    if (!date) continue;
    (days.get(date) ?? days.set(date, []).get(date)!).push(e);
  }

  return [...days.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, list]) => ({
      date,
      label: describeDay(date, now),
      events: [...list].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
    }));
}

/** Events matching a type filter. An empty filter means everything. */
export function filterEvents(events: HistoryEvent[], types: string[]): HistoryEvent[] {
  if (types.length === 0) return events;
  return events.filter((e) => types.includes(e.eventType));
}

export interface HistorySummary {
  totalEvents: number;
  days: number;
  byType: { type: string; label: string; count: number }[];
}

export function summariseHistory(events: HistoryEvent[]): HistorySummary {
  const counts = new Map<string, number>();
  const days = new Set<string>();

  for (const e of events) {
    counts.set(e.eventType, (counts.get(e.eventType) ?? 0) + 1);
    if (e.occurredAt) days.add(isoDate(e.occurredAt));
  }

  return {
    totalEvents: events.length,
    days: days.size,
    byType: [...counts.entries()]
      .map(([type, count]) => ({
        type,
        label: EVENT_FILTERS.find((f) => f.type === type)?.label ?? type,
        count,
      }))
      .sort((a, b) => b.count - a.count),
  };
}
