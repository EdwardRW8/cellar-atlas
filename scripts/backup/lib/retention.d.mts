/** Type contract for retention.mjs. Kept beside it so `tsc` can check the tests. */
export declare const BACKUP_NAME_PATTERN: RegExp;
export declare const RETENTION: { daily: number; weekly: number; monthly: number };
export declare function backupStem(date: Date): string;
export declare function parseBackupStem(stem: string): Date | null;
export declare function classifyObject(
  name: string,
): { stem: string; suffix: string } | null;
export interface BackupSet {
  stem: string;
  date: Date;
  objectNames: string[];
  missing: string[];
}
export declare function groupIntoSets(objectNames: string[]): {
  complete: BackupSet[];
  incomplete: BackupSet[];
  ignored: string[];
};
export declare function planRetention(
  objectNames: string[],
  opts?: { retention?: Partial<{ daily: number; weekly: number; monthly: number }> },
): {
  keepStems: string[];
  pruneStems: string[];
  pruneObjects: string[];
  incompleteStems: string[];
  incompleteObjects: string[];
  ignored: string[];
  reason: string | null;
};
