/** Type contract for dump-plan.mjs. */
export declare const BACKUP_SCHEMAS: string[];
export declare const SCHEMA_DUMP_ORDER: string[];
export declare const MANIFEST_COUNT_QUERY: string;
export declare const MUST_NOT_BE_EMPTY: string[];
export declare function buildDumpPlan(
  stem: string,
): { name: string; file: string; command: string; args: string[]; kind: string }[];
export declare function expectedSuffixes(): string[];
export declare function countDumpRows(dataSql: string): Record<string, number>;
export declare function checkCounts(
  dumpCounts: Record<string, number>,
): { ok: boolean; problems: string[] };
export declare function compareCounts(
  dumpCounts: Record<string, number>,
  observedCounts: Record<string, number>,
): { table: string; dumped: number | null; observed: number; note: string }[];
