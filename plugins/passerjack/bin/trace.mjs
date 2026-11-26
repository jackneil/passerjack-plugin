/**
 * A CLOSED-WORD TRACE for a live check of the plugin's hooks and of the agent
 * bridge, OFF unless its switch is exactly `1`:
 *   - `PASSERJACK_HOOK_DEBUG=1`: the Claude Code plugin's hooks append to
 *     `hook-debug.log` in the `sessions` folder beside the credentials file;
 *   - `PASSERJACK_BRIDGE_DEBUG=1`: the agent bridge appends to
 *     `bridge-debug.log` in its state folder.
 * The hooks and the bridge print nothing and exit 0 on every path, so without
 * this a failure is silent; with it, the file says which step failed.
 *
 * ONLY CLOSED WORDS: a harness, an event, an outcome, a status code, an error
 * class or code, a count. Never a text, an id, a token, a key or a path. Each
 * word is cut to `TRACE_WORD_CHARS`, every character outside
 * `[A-Za-z0-9_.:=,-]` becomes `?`, and a uuid or any run of 24 or more
 * letters and digits (a `pj_` key is 40) becomes one `?`, so a caller that
 * passes something else by mistake still cannot write it whole (/dcr wave 2:
 * the earlier filter let a key through, every one of its characters being
 * allowed). The file is 0600 in a 0700 folder.
 *
 * DEPENDENCY-FREE, Node 18+. A trace is never worth a failure: it never throws.
 */

import fs from "node:fs";
import path from "node:path";

/** The switch of each trace. */
export const TRACE_SWITCHES = Object.freeze({ hook: "PASSERJACK_HOOK_DEBUG", bridge: "PASSERJACK_BRIDGE_DEBUG" });

/** The longest one word of a trace line. */
export const TRACE_WORD_CHARS = 60;

/** One word, reduced to the closed shape. */
export function traceWord(value) {
  return String(value ?? "-")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "?")
    .replace(/[A-Za-z0-9]{24,}/g, "?")
    .slice(0, TRACE_WORD_CHARS)
    .replace(/[^A-Za-z0-9_.:=,-]/g, "?");
}

/** One trace line: the time, then the words, each reduced by `traceWord`. */
export function traceLine(words, now = new Date()) {
  const out = words.flatMap((word) => String(word ?? "-").split(/\s+/)).filter(Boolean).map(traceWord);
  return `${now.toISOString()} ${out.join(" ")}\n`;
}

/**
 * Append one line to `file` when `env[flag]` is exactly `1`. Never throws.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} flag
 * @param {string} file
 * @param {unknown[]} words
 */
export function trace(env, flag, file, ...words) {
  if (env?.[flag] !== "1") return;
  try {
    const dir = path.dirname(file);
    const made = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32" && made !== undefined) fs.chmodSync(dir, 0o700);
    fs.appendFileSync(file, traceLine(words), { mode: 0o600 });
  } catch {
    // A trace is never worth a failure.
  }
}
