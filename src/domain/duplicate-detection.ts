/**
 * Duplicate detection for Add Wine.
 *
 * The single biggest guard against a cluttered collection. Offering "you
 * already own this — add bottles instead?" is far better than letting two
 * near-identical wine definitions accumulate, because merging them later is
 * genuinely hard once bottles and events reference both.
 */

import type { WineSummary } from "./types";

export interface DuplicateMatch {
  wineId: string;
  producer: string;
  name: string;
  vintage: number | null;
  activeBottles: number;
  /** 0–1. 1 means producer, name and vintage all match. */
  score: number;
  reason: string;
}

function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(chateau|château|domaine|dom|ch|the|le|la|les)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

/** Levenshtein, capped — we only care about near-misses. */
function distance(a: string, b: string, max = 4): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      best = Math.min(best, curr[j]!);
    }
    if (best > max) return max + 1;
    prev = curr;
  }
  return prev[b.length]!;
}

function similar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const threshold = Math.min(3, Math.floor(Math.max(a.length, b.length) / 5));
  return distance(a, b, threshold) <= threshold;
}

export function findDuplicates(
  candidate: { producer: string | null; name: string | null; vintage: number | null },
  existing: WineSummary[],
): DuplicateMatch[] {
  if (!candidate.producer?.trim() || !candidate.name?.trim()) return [];

  const cp = normalise(candidate.producer);
  const cn = normalise(candidate.name);
  const matches: DuplicateMatch[] = [];

  for (const w of existing) {
    const ep = normalise(w.wine.producer);
    const en = normalise(w.wine.name);

    const producerMatch = ep === cp ? 1 : similar(ep, cp) ? 0.7 : 0;
    if (producerMatch === 0) continue;

    const nameMatch = en === cn ? 1 : similar(en, cn) ? 0.7 : 0;
    if (nameMatch === 0) continue;

    const vintageMatch =
      candidate.vintage === w.wine.vintage
        ? 1
        : candidate.vintage === null || w.wine.vintage === null
          ? 0.4
          : 0;

    const score = producerMatch * 0.35 + nameMatch * 0.35 + vintageMatch * 0.3;
    if (score < 0.5) continue;

    matches.push({
      wineId: w.wine.id,
      producer: w.wine.producer,
      name: w.wine.name,
      vintage: w.wine.vintage,
      activeBottles: w.activeBottles,
      score,
      reason:
        score === 1
          ? "Exact match — same producer, wine and vintage"
          : vintageMatch === 1
            ? "Very similar name, same vintage"
            : vintageMatch === 0
              ? "Same wine, different vintage"
              : "Similar wine",
    });
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, 5);
}

/** An exact match should interrupt the user; a loose one should merely inform. */
export function shouldBlock(matches: DuplicateMatch[]): boolean {
  return matches.some((m) => m.score === 1);
}
