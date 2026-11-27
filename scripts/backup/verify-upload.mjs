#!/usr/bin/env node
/**
 * VERIFY THE UPLOADED SET, AND SAY WHETHER PRUNING IS SAFE.
 *
 * Run between upload and prune. Reads the local manifest, reads each object
 * back FROM the bucket, hashes it, and compares against the hash recorded at
 * encryption time. Exits non-zero if anything is missing or differs — which
 * is what stops the workflow before it deletes an older backup on the
 * strength of one that did not arrive intact.
 *
 * The download and hashing happen in the caller (the workflow) because only
 * it holds the bucket credentials; this script consumes the results. That
 * keeps the credential out of this process entirely.
 *
 * Usage:
 *   node scripts/backup/verify-upload.mjs \
 *     --manifest <path to local manifest.json> \
 *     --hashes <path to "sha256  name" lines from the re-downloaded objects>
 */

import { readFileSync } from "node:fs";
import { verifyUploadedSet, pruneIsSafe } from "./lib/verify-upload.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const manifestPath = arg("manifest");
const hashesPath = arg("hashes");
if (!manifestPath || !hashesPath) {
  console.error("verify-upload: --manifest and --hashes are both required");
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (e) {
  console.error(`verify-upload: cannot read the manifest: ${e.message}`);
  process.exit(1);
}

/**
 * `sha256sum` output, as produced by hashing the re-downloaded objects.
 * Basenames only: the local paths they were downloaded to are irrelevant.
 */
const remoteHashes = new Map();
for (const line of readFileSync(hashesPath, "utf8").split("\n")) {
  const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
  if (m) remoteHashes.set(m[2].replace(/^.*\//, ""), m[1]);
}

const result = verifyUploadedSet({ stem: manifest.stem, manifest, remoteHashes });

for (const problem of result.problems) console.error(`verify-upload: ${problem}`);

if (!pruneIsSafe(result)) {
  console.error(
    `verify-upload: REFUSING to confirm ${manifest.stem}. Retention must not run: ` +
      `an older complete backup would be deleted on the strength of this one.`,
  );
  process.exit(1);
}

console.error(
  `verify-upload: ${manifest.stem} verified — ${result.checked} encrypted files match ` +
    `their recorded SHA-256, and the manifest is readable from the bucket.`,
);
process.stdout.write(`${JSON.stringify({ stem: manifest.stem, verified: true })}\n`);
