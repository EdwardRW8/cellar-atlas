/**
 * THE ENCRYPTION RECIPIENT, AND WHY THIS FILE REFUSES TO GUESS.
 *
 * `backup/age-recipient.txt` holds an age PUBLIC key. A public key is safe to
 * commit — that is the whole reason this design uses asymmetric encryption:
 * the runner can encrypt a dump it can never read back, and the private key
 * never leaves the owner's machine.
 *
 * The file ships as a placeholder, because only the owner can generate the
 * key pair. Everything here exists to make that placeholder FAIL LOUDLY:
 *
 *   - a backup must never run unencrypted because the key was not set up;
 *   - a backup must never run encrypted to a key nobody holds, which looks
 *     like success for months and is discovered only at a restore.
 *
 * The second is the dangerous one. An unencrypted dump is a visible mistake.
 * Thirty undecryptable files are an invisible one.
 */

import { readFileSync } from "node:fs";

export const RECIPIENT_PATH = "backup/age-recipient.txt";

/** The marker the committed placeholder carries. */
export const PLACEHOLDER_MARKER = "REPLACE_WITH_YOUR_AGE_PUBLIC_KEY";

/**
 * An age X25519 recipient: `age1` followed by 58 bech32 characters.
 * Matching the real shape is what makes the placeholder detectable.
 */
const AGE_RECIPIENT = /^age1[0-9a-z]{58}$/;

/**
 * Pull the recipient out of the file's text.
 *
 * Comments (`#`) and blank lines are allowed so the committed file can explain
 * itself. Exactly one key must remain: two keys would silently mean a second
 * party can decrypt every backup, which is a decision for the owner to make
 * explicitly rather than something to infer from a file that drifted.
 */
export function parseRecipientFile(text) {
  if (typeof text !== "string") throw new Error("Recipient file is not readable text.");

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));

  if (lines.length === 0) {
    throw new Error(
      `${RECIPIENT_PATH} contains no recipient. Backups cannot be encrypted, so none will be taken. See docs/disaster-recovery.md.`,
    );
  }

  if (lines.some((l) => l.includes(PLACEHOLDER_MARKER))) {
    throw new Error(
      `${RECIPIENT_PATH} still holds the placeholder. Generate an age key pair, keep the PRIVATE key offline, and commit only the public key. See docs/disaster-recovery.md.`,
    );
  }

  if (lines.length > 1) {
    throw new Error(
      `${RECIPIENT_PATH} lists ${lines.length} recipients. Every listed key can decrypt every backup, so this must be a deliberate change, not a leftover.`,
    );
  }

  const recipient = lines[0];

  // The catastrophic typo this catches: a PRIVATE key pasted in by mistake.
  // It would be committed to the repository and published with it.
  if (/^AGE-SECRET-KEY-/i.test(recipient)) {
    throw new Error(
      `${RECIPIENT_PATH} contains an age PRIVATE key. Remove it, rotate the key pair immediately, and commit only the age1... public key.`,
    );
  }

  if (!AGE_RECIPIENT.test(recipient)) {
    throw new Error(
      `${RECIPIENT_PATH} does not hold a valid age public key (expected age1… with 58 characters).`,
    );
  }

  return recipient;
}

/** Read and validate the committed recipient file. Throws, never defaults. */
export function readRecipient(path = RECIPIENT_PATH) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`${path} is missing. Backups cannot be encrypted without it.`);
  }
  return parseRecipientFile(text);
}
