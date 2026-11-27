/**
 * PROVE THE UPLOAD ARRIVED, BEFORE ANYTHING IS DELETED.
 *
 * Pruning assumes today's backup is safely in the bucket. If the upload was
 * partial — a dropped connection, a token that expired mid-transfer, a
 * provider error on one object — then pruning would remove an older complete
 * backup on the strength of a backup that is not there. That is how a backup
 * system destroys data.
 *
 * So the workflow verifies first, and prunes only if this passes. Verification
 * is against the manifest's own hashes, re-read from the bucket, because
 * "the object exists" and "the object is intact" are different claims:
 * a truncated upload exists.
 *
 * Pure, so the comparison logic is testable without a bucket; the caller does
 * the listing and the downloading.
 */

import { expectedSuffixes } from "./dump-plan.mjs";

/**
 * Check a freshly uploaded set against its manifest.
 *
 * @param {object} args
 * @param {string} args.stem              The set just uploaded.
 * @param {object} args.manifest          The manifest written locally.
 * @param {Map<string,string>} args.remoteHashes
 *        Object name → SHA-256 of the bytes read back FROM the bucket.
 *        A name absent from the map means the object could not be read.
 * @returns {{ok: boolean, problems: string[], checked: number}}
 */
export function verifyUploadedSet({ stem, manifest, remoteHashes }) {
  const problems = [];

  if (!manifest || manifest.stem !== stem) {
    return {
      ok: false,
      checked: 0,
      problems: [`manifest is missing or describes a different backup than ${stem}`],
    };
  }

  // 1. Every file the set is supposed to contain must be present.
  const required = expectedSuffixes();
  for (const suffix of required) {
    const name = `${stem}${suffix}`;
    if (!remoteHashes.has(name)) problems.push(`${name}: not readable from the bucket`);
  }

  // 2. Every encrypted file must match the hash recorded at encryption time.
  //    This is what distinguishes "arrived" from "arrived intact".
  let checked = 0;
  for (const entry of manifest.files ?? []) {
    // `entry.file` is already the full object name, stem included.
    const objectName = entry.file;
    if (!objectName.startsWith(stem)) {
      problems.push(`${objectName}: manifest lists a file from a different backup set`);
      continue;
    }
    const remote = remoteHashes.get(objectName);
    if (remote === undefined) continue; // already reported above
    checked += 1;
    if (remote !== entry.encryptedSha256) {
      problems.push(
        `${objectName}: SHA-256 mismatch — uploaded bytes differ from what was encrypted`,
      );
    }
  }

  // 3. The manifest must itself have arrived, or nothing can be verified
  //    later, at a restore.
  if (!remoteHashes.has(`${stem}.manifest.json`)) {
    problems.push(`${stem}.manifest.json: not readable from the bucket`);
  }

  // 4. A set whose own counts were rejected must never be treated as a good
  //    backup, even if every byte uploaded perfectly.
  if (manifest.dumpCountsOk === false) {
    problems.push("the dump's own row counts were rejected — this is not a usable backup");
  }

  return { ok: problems.length === 0, problems, checked };
}

/**
 * Is it safe to prune?
 *
 * Separate from the verification itself so the workflow reads as:
 * verify → decide → delete, with the refusal explicit rather than implied by
 * an early exit.
 */
export function pruneIsSafe(verification) {
  return Boolean(verification && verification.ok);
}
