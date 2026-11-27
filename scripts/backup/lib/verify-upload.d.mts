/** Type contract for verify-upload.mjs. */
export declare function verifyUploadedSet(args: {
  stem: string;
  manifest: Record<string, unknown> | null;
  remoteHashes: Map<string, string>;
}): { ok: boolean; problems: string[]; checked: number };
export declare function pruneIsSafe(
  verification: { ok: boolean } | null | undefined,
): boolean;
