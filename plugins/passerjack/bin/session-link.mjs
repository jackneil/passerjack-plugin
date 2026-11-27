/**
 * THE LINK between the watcher and the plugin's hooks of ONE Claude Code
 * session (design `docs/plans/2026-11-25-agents-ui/design.html`, section 6).
 *
 * The watcher (a monitor) registers the session with PasserJack and knows its
 * session id; a hook (Stop, Notification, UserPromptSubmit) is a separate
 * short process that needs that id to post the turn's state. The watcher
 * writes the id to a small file; a hook of the same Claude Code session reads
 * it. The file holds the session id, the origin and the watcher's process id,
 * and NEVER a credential.
 *
 * THE KEY is `CLAUDE_PID`, the Claude Code process id. Both a monitor and a
 * hook carry it, with the same value. Measured on this machine on 2026-11-25
 * (Claude Code 2.1.332): `CLAUDE_CODE_SESSION_ID` is also in both, but `/clear`
 * gives the hooks a new one while the monitor keeps the old one, and the
 * monitor's `CLAUDE_PLUGIN_DATA` is another plugin's (the shell snapshot that
 * starts a monitor sets it), so neither can name the file.
 *
 * THE PLACE is a `sessions` folder beside the credentials file
 * (`credentialsPath`), 0700, each file 0600, written by a rename so a hook
 * never reads half a file. A hook that finds no file, or a file whose
 * watcher has exited, does nothing.
 *
 * THE REMOTE-ANSWER MARK (plugin 0.4.0, design
 * `docs/plans/2026-11-26-remote-permission/design.html`, D8): `remote` is
 * `remoteMark` (`credentials.mjs`) of the bearer that the watcher proved may
 * get the owner's answers to a permission prompt, or absent. The request hook
 * takes part only when the mark of its own bearer is this mark. A link of a
 * 0.3.0 watcher has no mark, so its hooks get no remote answers.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { credentialsPath, removeJsonIfOwned, withLock, writeJsonAtomic } from "./credentials.mjs";
import { TOOL_RE } from "./hook-core.mjs";
import { claudeKey } from "./watch-core.mjs";

export { claudeKey };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A remote-answer mark: a sha256 in hex (`remoteMark`). */
const MARK_RE = /^[0-9a-f]{64}$/;

/** Link files older than this are a session that ended without saying so, and the watcher sweeps them. */
export const STALE_LINK_MS = 2 * 24 * 60 * 60 * 1000;

/** The folder of link files. */
export function linksDir(options) {
  return path.join(path.dirname(credentialsPath(options)), "sessions");
}

/** The link file of one Claude Code process. */
export function linkPath(dir, key) {
  return path.join(dir, `${key}.json`);
}

/** Read a small JSON file, or null. */
function readJson(file, maxChars = 4096) {
  try {
    const text = fs.readFileSync(file, "utf8");
    if (text.length > maxChars) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The watcher's side: say which PasserJack session this Claude Code process
 * holds. Never throws. Answers whether the link landed: a watcher whose link
 * could not be written registers with `waits: false` (watch.mjs), because
 * its hooks find no session and would never post the idle that releases a
 * held question push.
 *
 * `remote` is the remote-answer mark of the watcher's bearer, or null when
 * that bearer gets no remote answers (D8).
 *
 * @param {{ dir: string, key: string | null, sessionId: string, origin: string, watcherPid: number, remote?: string | null }} link
 * @returns {boolean}
 */
export function writeLink({ dir, key, sessionId, origin, watcherPid, remote = null }) {
  if (!key || !UUID_RE.test(sessionId)) return false;
  const value = { v: 1, sessionId: sessionId.toLowerCase(), origin, watcherPid };
  if (typeof remote === "string" && MARK_RE.test(remote)) value.remote = remote;
  try {
    writeJsonAtomic(linkPath(dir, key), value);
    return true;
  } catch {
    // No link: the hooks do nothing, and the watch goes on.
    return false;
  }
}

/**
 * The watcher's side on the way out, or when it lost its session: remove the
 * link ONLY while it still names this watcher (`watcherPid`). Two watchers can
 * run in one Claude Code process (a plugin reload), and the one that exits
 * must not take away the other's link. Never throws. Synchronous, because it
 * runs in the process's `exit` handler.
 *
 * `removeJsonIfOwned` moves the file aside before it reads it, so a link
 * that the other watcher wrote between a read and a remove is never removed
 * (/dcr wave 2), and the other watcher's `tick` puts a link back within 3 s
 * if a hard link could not.
 *
 * @param {string} dir
 * @param {string | null} key
 * @param {number} watcherPid
 */
export function removeLink(dir, key, watcherPid) {
  if (!key) return;
  removeJsonIfOwned(linkPath(dir, key), (link) => Boolean(link) && /** @type {{ watcherPid?: unknown }} */ (link).watcherPid === watcherPid);
}

/**
 * Does a link of ANOTHER Claude Code process (another key) name this session,
 * with its watcher still running? Two terminals that resume one Claude Code
 * session (`claude --continue` while the first still runs) derive the same
 * presence `clientId` and would share one row, so both would act on and ack
 * one owner message (/dcr wave 2). The watcher that finds one registers with
 * a random `clientId` instead (`Presence` in watch.mjs). With `lowerThan`,
 * only the keys below it count: two terminals that started in the same
 * instant both see each other, and only the higher one moves.
 *
 * @param {string} dir
 * @param {string | null} key
 * @param {string} sessionId
 * @param {{ lowerThan?: string | null, alive?: (pid: number) => boolean }} [options]
 */
export function linkedElsewhere(dir, key, sessionId, { lowerThan = null, alive = processAlive } = {}) {
  if (!key || !UUID_RE.test(sessionId)) return false;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  const wanted = sessionId.toLowerCase();
  for (const name of names) {
    const match = /^([0-9]+)\.json$/.exec(name);
    if (!match || match[1] === key) continue;
    if (lowerThan !== null && !(Number(match[1]) < Number(lowerThan))) continue;
    const held = linkHolder(dir, match[1]);
    if (held && held.sessionId.toLowerCase() === wanted && alive(held.watcherPid)) return true;
  }
  return false;
}

/**
 * What the link file says now, with no check that its watcher runs: the
 * watcher's own check (`ensureLink` in watch.mjs) that its link is still
 * there. Null for no file or one that is not a link.
 */
export function linkHolder(dir, key) {
  if (!key) return null;
  const link = readJson(linkPath(dir, key));
  if (!link || link.v !== 1 || typeof link.sessionId !== "string" || !Number.isSafeInteger(link.watcherPid)) return null;
  return { sessionId: link.sessionId, watcherPid: link.watcherPid, remote: remoteOf(link) };
}

/** A link's remote-answer mark, or null. */
function remoteOf(link) {
  return typeof link.remote === "string" && MARK_RE.test(link.remote) ? link.remote : null;
}

/** A Claude Code session id as the environment carries it: one short printable line. */
const CLAUDE_SESSION_RE = /^[A-Za-z0-9._:-]{8,200}$/;

/**
 * THE PRESENCE `clientId` OF ONE WATCH. With `CLAUDE_CODE_SESSION_ID` set
 * (Claude Code sets it for every process it starts: the transcript's id,
 * the same after a compaction and, by design, after a resume), the id is a
 * hash of that session, the origin and the sign-in (`signInIdentity`), shaped
 * as a uuid (version 8, RFC 9562), which is all the server asks of a
 * `clientId`. So a restarted or resumed Claude Code registers the SAME row,
 * and a message the owner sent to that row still reaches it; two watchers in
 * one Claude Code PROCESS (a plugin reload) share the row. Two running
 * processes on one session (a second terminal that resumed it) must not:
 * the later one finds the earlier one's live link (`linkedElsewhere`) and
 * registers with a random id. The sign-in is in the hash
 * because the server refuses (409) a `clientId` that another credential
 * registered: a new sign-in gets a new row. With no session id, a random
 * uuid, as before.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ origin: string, identity: string }} watch
 * @param {() => string} [random]
 */
export function sessionClientId(env, { origin, identity }, random = crypto.randomUUID) {
  const session = String(env?.CLAUDE_CODE_SESSION_ID ?? "").trim();
  if (!CLAUDE_SESSION_RE.test(session) || !identity) return random();
  const hex = crypto.createHash("sha256").update(`passerjack-presence\0${origin}\0${session}\0${identity}`).digest("hex").split("");
  hex[12] = "8";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * The hook's side: the link of this Claude Code process, or null. The
 * watcher that wrote it must still be running (`alive`), so a file that a
 * crashed watcher left behind, or one from an earlier process that had the
 * same id, is never used.
 *
 * @param {string} dir
 * @param {string | null} key
 * @param {(pid: number) => boolean} alive
 */
export function readLink(dir, key, alive) {
  if (!key) return null;
  const link = readJson(linkPath(dir, key));
  if (!link || link.v !== 1 || typeof link.sessionId !== "string" || !UUID_RE.test(link.sessionId)) return null;
  if (typeof link.origin !== "string" || !Number.isSafeInteger(link.watcherPid)) return null;
  if (!alive(link.watcherPid)) return null;
  return { sessionId: link.sessionId, origin: link.origin, watcherPid: link.watcherPid, remote: remoteOf(link) };
}

/** Whether a process id names a running process. */
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it runs, as another user. Anything else: it does not.
    return Boolean(err && err.code === "EPERM");
  }
}

/**
 * THE HOOKS' OWN STATE of one Claude Code process, `<CLAUDE_PID>.hooks.json`
 * beside the link (design section 6; dcr wave 1 P4 and P5). The hooks write
 * it, under its lock, and the watcher never does, so a relink cannot wipe it.
 * No credential, no text: a counter, one mark and the live request hooks.
 *   - `turn`: bumped by every prompt and every session start (a `/clear`, a
 *     resume, a compaction). A Stop waiter posts `idle` only when it did not
 *     move during its minute, so a late `idle` never overwrites `working`.
 *   - `requestTurn` (0.4.0, /dcr wave 1 finding 56): the request hooks' own
 *     counter. ONLY a prompt that the person typed and a session start that
 *     is not a compaction (`startup`, `resume`, `clear`) bump it. A turn that
 *     a monitor line starts (an owner message, a tagged item) and a
 *     compaction say nothing about a prompt that is up, so they leave a
 *     waiting request hook alone.
 *   - `pending`: the permission prompt that the Notification waiter watches,
 *     `{ n, at, tool, toolUseId, posted }`, or null. A finished tool, a
 *     prompt, a Stop or a session start clears it; the waiter of mark `n`
 *     posts only while it is still the mark.
 *   - `requests` (0.4.0): one entry per running PermissionRequest hook,
 *     `{ n, pid, toolUseId, call, accepted }`. `accepted` says that the server
 *     took its request row, so that hook (and not the Notification waiter)
 *     asks for the push. `call` is a sha256 of the call's tool name and input
 *     (`callDigest` in `hook-core.mjs`), never the input itself. A finished
 *     tool clears the entry of its call: by `toolUseId`, and for an entry with
 *     no id, by `call` (the finished call's name and input, one entry for
 *     each finished call). A typed prompt, a session start that is not a
 *     compaction, and a Stop with no live background work clear them all:
 *     the hook reads a missing entry as "answered at the terminal". Several
 *     entries can be
 *     open at once, one per prompt, so one prompt never closes another's
 *     row. An entry of a hook that no longer runs is dropped at the next
 *     request hook's write. The request key itself is never here: it stays in
 *     the hook's memory.
 */
export function hookStatePath(dir, key) {
  return path.join(dir, `${key}.hooks.json`);
}

/**
 * @typedef {{ n: number, at: number, tool: string | null, toolUseId: string | null, posted: boolean }} PermissionMark
 * @typedef {{ n: number, pid: number, toolUseId: string | null, call: string | null, accepted: boolean }} RequestMark
 * @typedef {{ pid: number, n: number }} ShellClaim
 * @typedef {{ v: 1, turn: number, requestTurn: number, marks: number, pending: PermissionMark | null, requests: RequestMark[], claims: ShellClaim[] }} HookState
 */

/**
 * A new hooks' state.
 *
 * @returns {HookState}
 */
export function newHookState() {
  return { v: 1, turn: 0, requestTurn: 0, marks: 0, pending: null, requests: [], claims: [] };
}

/**
 * The most request entries a state keeps. Each one is a RUNNING hook process
 * (one per open permission prompt), and a dead hook's entry is dropped at
 * the next write, so a real session holds a few. The bound is for a file
 * that was crafted or damaged: the read refuses a file over
 * `HOOK_STATE_MAX_CHARS`, and that would reset the turn counter too.
 */
export const MAX_REQUEST_MARKS = 32;
/** The longest hooks' state file that is read; `MAX_REQUEST_MARKS` entries fit in it with room to spare. */
const HOOK_STATE_MAX_CHARS = 16_384;

const TOOL_USE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** A call digest: a lowercase sha256 in hex. */
const CALL_DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * A parsed hooks' state, repaired field by field.
 *
 * @param {any} value
 * @returns {HookState}
 */
export function parseHookState(value) {
  const out = newHookState();
  if (!value || typeof value !== "object" || value.v !== 1) return out;
  if (Number.isSafeInteger(value.turn) && value.turn >= 0) out.turn = value.turn;
  if (Number.isSafeInteger(value.requestTurn) && value.requestTurn >= 0) out.requestTurn = value.requestTurn;
  if (Number.isSafeInteger(value.marks) && value.marks >= 0) out.marks = value.marks;
  const p = value.pending;
  if (p && typeof p === "object" && Number.isSafeInteger(p.n) && Number.isFinite(p.at)) {
    out.pending = {
      n: p.n,
      at: p.at,
      tool: typeof p.tool === "string" && TOOL_RE.test(p.tool) ? p.tool : null,
      toolUseId: typeof p.toolUseId === "string" && TOOL_USE_ID_RE.test(p.toolUseId) ? p.toolUseId : null,
      posted: p.posted === true,
    };
  }
  if (Array.isArray(value.requests)) {
    for (const r of value.requests) {
      if (out.requests.length >= MAX_REQUEST_MARKS) break;
      if (!r || typeof r !== "object" || !Number.isSafeInteger(r.n) || !Number.isSafeInteger(r.pid) || r.pid <= 0) continue;
      out.requests.push({
        n: r.n,
        pid: r.pid,
        toolUseId: typeof r.toolUseId === "string" && TOOL_USE_ID_RE.test(r.toolUseId) ? r.toolUseId : null,
        call: typeof r.call === "string" && CALL_DIGEST_RE.test(r.call) ? r.call : null,
        accepted: r.accepted === true,
      });
    }
  }
  if (Array.isArray(value.claims)) {
    for (const c of value.claims) {
      if (out.claims.length >= MAX_REQUEST_MARKS) break;
      if (!c || typeof c !== "object" || !Number.isSafeInteger(c.pid) || c.pid <= 0 || !Number.isSafeInteger(c.n)) continue;
      out.claims.push({ pid: c.pid, n: c.n });
    }
  }
  return out;
}

/** The hooks' state of this Claude Code process, or null with no key. Never throws. */
export function readHookState(dir, key) {
  if (!key) return null;
  return parseHookState(readJson(hookStatePath(dir, key), HOOK_STATE_MAX_CHARS));
}

/** The longest a hook waits for the state's lock; a lock older than this much more is a dead hook's. */
const HOOK_LOCK_WAIT_MS = 3000;
const HOOK_LOCK_STALE_MS = 10_000;

/**
 * Change the hooks' state under its lock: `fn` changes the state in place and
 * answers what the caller gets. Null with no key, or when the lock or the
 * write failed (a hook then does nothing). Never throws.
 *
 * @template T
 * @param {string} dir
 * @param {string | null} key
 * @param {(state: HookState) => T} fn
 * @returns {Promise<T | null>}
 */
export async function updateHookState(dir, key, fn) {
  if (!key) return null;
  const file = hookStatePath(dir, key);
  try {
    return await withLock(
      file,
      async () => {
        const state = parseHookState(readJson(file, HOOK_STATE_MAX_CHARS));
        const out = fn(state);
        writeJsonAtomic(file, state);
        return out;
      },
      { staleMs: HOOK_LOCK_STALE_MS, waitMs: HOOK_LOCK_WAIT_MS },
    );
  } catch {
    return null;
  }
}

/** The watcher's start: remove link and hooks' state files older than `STALE_LINK_MS`. Never throws. */
export function sweepLinks(dir, now = Date.now()) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^[0-9]+\.(hooks\.)?json$/.test(name) && !name.endsWith(".tmp") && !name.endsWith(".lock")) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > STALE_LINK_MS) fs.rmSync(file, { force: true });
    } catch {
      // Raced with its owner, or not ours.
    }
  }
}
