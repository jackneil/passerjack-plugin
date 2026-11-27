/**
 * The bridge's rules and its state file: what one hook event changes, which
 * owner messages a turn end hands on, the words that frame them, and when the
 * minute of silence has passed. `bridge.mjs` is the half with the network,
 * the child processes and stdout.
 *
 * THE STATE FILE. One small JSON file per harness session, 0600, in a folder
 * of its own (0700) beside the credentials file. Its name is a hash of the
 * harness and its session id, so no id is in a file name. It holds:
 *   - `clientId`: the uuid the session registers with, so a re-registration
 *     answers the same row (`POST /api/sessions`);
 *   - `sessionId`: the PasserJack session id, once registered;
 *   - `counter`: bumped by every event that is a sign of life, so a waiter
 *     can tell "nothing happened for a minute" from "the user typed";
 *   - `delivered`: the ids of the owner messages this session was given, so
 *     no message is given twice (an ack needs `write`, and the shared sign-in
 *     is `read`: this ledger, not the ack, is what makes delivery at most once);
 *   - `pending` and `wait`: the wait a waiter will post, and the one it posted;
 *   - `requests`: the permission prompts that wait for the owner's answer
 *     from PasserJack, KEYED BY THE REQUEST KEY (a uuid the bridge makes per
 *     prompt): the program's own id of the prompt (opencode's), the tool's
 *     name, when it was asked, and the process that waits. An entry leaves
 *     the map when its prompt closes by any path, the owner's answer
 *     included. NEVER the tool's input: the waiting
 *     process keeps the input in its memory and sends it in the one request
 *     post, so a killed process leaves no input on the disk;
 *   - `taken` (a shim only): the requests whose owner's answer the waiter
 *     took and printed, BY THE PROGRAM'S OWN ID of the prompt (opencode's):
 *     the request key and when. The plugin hands the answer on out of band,
 *     and when opencode refuses it (`reply_refused`) the bridge closes that
 *     key's row as answered at the terminal (/dcr wave 1 finding 29). The echo
 *     of the plugin's own reply (`permission.replied`) removes the entry. It
 *     is a map of its own, so that echo never reads as a prompt that still
 *     waits (the `requests` map).
 * NEVER a credential, a key or a token. The last message waits here for its
 * minute (the user's own text, on the user's own machine, 0600), and is
 * removed when it is posted or replaced.
 *
 * THE PLACE IS FIXED BY THE HOME FOLDER ONLY, as for the credentials file: a
 * repository's settings can set environment variables for a hook, and one
 * that moved this folder could make a hook write into the repository.
 *
 * DEPENDENCY-FREE, Node 18+: it imports only the plugin's own `bin/` files.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { signInIdentity, writeJsonAtomic } from "../bin/credentials.mjs";
import { PERMISSION_PUSH_AFTER_MS } from "../bin/hook-core.mjs";

/** The minute of silence before a finished turn or an open prompt is posted (design C8). */
export const IDLE_DELAY_MS = 60_000;

/** `PASSERJACK_BRIDGE_IDLE_MS` may move the minute only inside these bounds (a test seam). */
export const MIN_IDLE_DELAY_MS = 1000;
export const MAX_IDLE_DELAY_MS = 10 * 60_000;

/** How many delivered ids a session keeps. A message lives one day; this is far more than a day of them. */
export const MAX_DELIVERED_IDS = 500;

/** The most text one decision hands on; more messages wait for the next turn end. */
export const MAX_DELIVERY_CHARS = 16_000;

/** One owner message's cap, the server's entry cap. */
export const MAX_OWNER_MESSAGE_CHARS = 8000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The folder of the state files. Home folder and platform only, never an environment variable. */
export function stateDir({ home = os.homedir(), platform = process.platform } = {}) {
  if (platform === "win32") return path.win32.join(home, "AppData", "Local", "PasserJack", "agent-bridge-state");
  return path.posix.join(home, ".config", "passerjack", "agent-bridge-state");
}

/** The state file of one harness session. */
export function statePath(dir, harness, sessionKey) {
  const hash = crypto.createHash("sha256").update(`${harness}\0${sessionKey}`).digest("hex").slice(0, 40);
  return path.join(dir, `${hash}.json`);
}

/** Where a harness whose events do not all carry the session id (Junie) finds it: by the parent process. */
export function aliasPath(dir, harness, ppid) {
  const hash = crypto.createHash("sha256").update(`alias\0${harness}\0${ppid}`).digest("hex").slice(0, 40);
  return path.join(dir, `${hash}.alias`);
}

/**
 * Where a monitor that was started with no session id (Grok Build's watch)
 * finds its session: an alias keyed by a process ABOVE the hook (its parent
 * and the one above that: the harness, maybe behind a shell), written at
 * session start with that process's start time, so a reused process id is
 * never taken for it.
 */
export function ancestorAliasPath(dir, harness, pid) {
  const hash = crypto.createHash("sha256").update(`ancestor\0${harness}\0${pid}`).digest("hex").slice(0, 40);
  return path.join(dir, `${hash}.alias`);
}

/** How many processes above a hook get an alias, and how many above a watch are looked at. */
export const ALIAS_DEPTH = 2;

/** How far apart two start times of one process may be: `ps` ages are whole seconds. */
export const ALIAS_START_SLACK_MS = 2000;

/** A new state for a session the bridge has not seen. */
export function newState(harness, now = Date.now()) {
  return {
    v: 1,
    harness,
    clientId: crypto.randomUUID(),
    sessionId: null,
    cwd: null,
    counter: 0,
    delivered: [],
    turnDeliveries: 0,
    wait: null,
    pending: null,
    requests: {},
    taken: {},
    lastText: null,
    registerAt: 0,
    updatedAt: now,
  };
}

/**
 * A request entry older than this is dropped when the state is read: it is
 * longer than any wait (`SHIM_PERMISSION_WAIT_MS` of `harnesses.mjs`, twelve
 * hours), so its process is gone, and the server's sweep has closed its row.
 */
export const MAX_REQUEST_AGE_MS = 13 * 60 * 60_000;

/** A request id of the program (opencode's), as the adapter keeps it: one printable line of at most 200 characters. */
const ASK_RE = /^[\x21-\x7e]{1,200}$/;

/** The `requests` map of a state file, repaired entry by entry. */
function parseRequests(value, now) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, r] of Object.entries(value)) {
    if (!isUuid(key) || !r || typeof r !== "object" || !Number.isFinite(r.at) || now - r.at > MAX_REQUEST_AGE_MS) continue;
    out[key.toLowerCase()] = {
      ask: typeof r.ask === "string" && ASK_RE.test(r.ask) ? r.ask : null,
      tool: typeof r.tool === "string" ? r.tool : null,
      at: r.at,
      pid: Number.isSafeInteger(r.pid) && r.pid > 1 ? r.pid : null,
    };
  }
  return out;
}

/**
 * The `taken` map of a state file, repaired entry by entry: the program's id
 * of the prompt to `{ key, at }`. An entry older than `MAX_REQUEST_AGE_MS` is
 * dropped: the plugin hands an answer on within seconds of the print.
 */
function parseTaken(value, now) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [ask, t] of Object.entries(value)) {
    if (!ASK_RE.test(ask) || !t || typeof t !== "object" || !isUuid(t.key) || !Number.isFinite(t.at) || now - t.at > MAX_REQUEST_AGE_MS) continue;
    out[ask] = { key: t.key.toLowerCase(), at: t.at };
  }
  return out;
}

/** How long a waiter lets the transcript settle before it takes its size as the baseline. */
export const TRANSCRIPT_SETTLE_MS = 3000;

/**
 * A state file not changed for this long belongs to a session that is gone:
 * the server forgets a session a day after its last sign of life, and an
 * owner message lives at most a day. The register worker removes it.
 */
export const STATE_MAX_AGE_MS = 3 * 24 * 60 * 60_000;

/** The size of a transcript file, or null when it cannot be read. Never its content. */
export function transcriptSize(file) {
  if (typeof file !== "string" || !file) return null;
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/** Remove state and alias files older than `STATE_MAX_AGE_MS`. Answers how many went. */
export function pruneStates(dir, now = Date.now()) {
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    // A state or alias file, or a temporary file that a write left when its process died.
    if (!/^[0-9a-f]{40}\.(json|alias)$/.test(name) && !/^\.[0-9a-f]{40}\.(json|alias)\.\d+\.[0-9a-f]{12}\.tmp$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > STATE_MAX_AGE_MS) {
        fs.rmSync(file, { force: true });
        removed += 1;
      }
    } catch {
      // Gone already.
    }
  }
  return removed;
}

/** A registration asked for less than this long ago is not asked for again. */
export const REGISTER_PENDING_MS = 10_000;

/**
 * True when this event should start a registration: no session id yet, and
 * none asked for in the last few seconds. Marks the ask in `state`.
 */
export function claimRegistration(state, now = Date.now()) {
  if (state.sessionId || now - state.registerAt < REGISTER_PENDING_MS) return false;
  state.registerAt = now;
  return true;
}

const isUuid = (value) => typeof value === "string" && UUID_RE.test(value);

/** A parsed state file, repaired field by field, or null when it is not one. */
export function parseState(value, harness, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.v !== 1 || value.harness !== harness) return null;
  if (!isUuid(value.clientId)) return null;
  const pending =
    value.pending && typeof value.pending === "object" && Number.isSafeInteger(value.pending.n) && Number.isFinite(value.pending.at)
      ? {
          n: value.pending.n,
          at: value.pending.at,
          state: value.pending.state === "waiting_permission" ? "waiting_permission" : "idle",
          lastMessage: typeof value.pending.lastMessage === "string" ? value.pending.lastMessage : null,
          tool: typeof value.pending.tool === "string" ? value.pending.tool : null,
          transcript: typeof value.pending.transcript === "string" ? value.pending.transcript : null,
          parent: Number.isSafeInteger(value.pending.parent) && value.pending.parent > 1 ? value.pending.parent : null,
        }
      : null;
  return {
    v: 1,
    harness,
    clientId: value.clientId.toLowerCase(),
    sessionId: isUuid(value.sessionId) ? value.sessionId.toLowerCase() : null,
    cwd: typeof value.cwd === "string" ? value.cwd : null,
    counter: Number.isSafeInteger(value.counter) && value.counter >= 0 ? value.counter : 0,
    delivered: Array.isArray(value.delivered) ? value.delivered.filter(isUuid).slice(-MAX_DELIVERED_IDS) : [],
    turnDeliveries: Number.isSafeInteger(value.turnDeliveries) && value.turnDeliveries >= 0 ? value.turnDeliveries : 0,
    wait: value.wait === "idle" || value.wait === "waiting_permission" ? value.wait : null,
    pending,
    requests: parseRequests(value.requests, now),
    taken: parseTaken(value.taken, now),
    lastText: typeof value.lastText === "string" ? value.lastText : null,
    registerAt: Number.isFinite(value.registerAt) ? value.registerAt : 0,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

/** The state in `file`, or null for a missing, unreadable or foreign file. Never throws. */
export function readState(file, harness) {
  try {
    return parseState(JSON.parse(fs.readFileSync(file, "utf8")), harness);
  } catch {
    return null;
  }
}

/** Make the state folder: 0700 when this call made it. */
export function ensureStateDir(dir, platform = process.platform) {
  const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform !== "win32" && created !== undefined) fs.chmodSync(dir, 0o700);
}

/**
 * Write the state atomically, mode 0600, through the plugin's one atomic
 * write (`writeJsonAtomic` in `../bin/credentials.mjs`). Throws on failure: a
 * caller that records a delivery must not print the decision when the record
 * did not land.
 */
export function writeState(file, state, platform = process.platform) {
  writeJsonAtomic(file, state, { platform });
}

/** `PASSERJACK_SHARE_LAST_MESSAGE`: on unless it is exactly `0` (the owner's choice, 2026-11-25). */
export function shareLastMessage(env) {
  return (env?.PASSERJACK_SHARE_LAST_MESSAGE ?? "").trim() !== "0";
}

/** The minute, or `PASSERJACK_BRIDGE_IDLE_MS` when it is a whole number inside the bounds. */
export function idleDelayMs(env) {
  const raw = (env?.PASSERJACK_BRIDGE_IDLE_MS ?? "").trim();
  if (!/^\d+$/.test(raw)) return IDLE_DELAY_MS;
  const ms = Number(raw);
  return ms >= MIN_IDLE_DELAY_MS && ms <= MAX_IDLE_DELAY_MS ? ms : IDLE_DELAY_MS;
}

/**
 * The owner messages a decision may hand on now, oldest first: `fromOwner`
 * messages only (agent-to-agent mail stays for the model's own
 * `check_messages`), not already delivered, with a body, and as many as fit
 * in `MAX_DELIVERY_CHARS`. The ones that do not fit stay for the next turn.
 */
export function pickOwnerMessages(messages, delivered, maxChars = MAX_DELIVERY_CHARS) {
  if (!Array.isArray(messages)) return [];
  const seen = new Set(delivered);
  const owner = messages
    .filter((m) => m && typeof m === "object" && m.fromOwner === true && isUuid(m.id) && !seen.has(m.id.toLowerCase()))
    .filter((m) => typeof m.body === "string" && m.body.trim().length > 0)
    .map((m) => ({
      id: m.id.toLowerCase(),
      entryId: isUuid(m.entryId) ? m.entryId.toLowerCase() : null,
      body: Array.from(m.body).slice(0, MAX_OWNER_MESSAGE_CHARS).join(""),
      createdAt: typeof m.createdAt === "string" ? m.createdAt : "",
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const out = [];
  let used = 0;
  for (const m of owner) {
    if (out.length > 0 && used + m.body.length > maxChars) break;
    out.push(m);
    used += m.body.length;
  }
  return out;
}

/**
 * THE WORDS THAT FRAME AN OWNER MESSAGE for the model (design C7): the owner's
 * own words to this one session, to act on as a line the user typed here,
 * inside the standing instructions and the permission rules, and how to
 * answer. ASD-STE100, no em-dash: it is text a person reads in the terminal.
 */
/**
 * @param {{ id: string, entryId: string | null, body: string, createdAt: string }[]} picked
 * @param {string | null} [sessionId]
 */
export function deliveryText(picked, sessionId = null) {
  if (!picked.length) return "";
  const session = isUuid(sessionId) ? ` with sessionId ${sessionId.toLowerCase()}` : "";
  const one = picked.length === 1;
  const lines = [
    one
      ? "[passerjack] The owner sent you a message from the PasserJack Agents page. The owner typed it for this session only."
      : `[passerjack] The owner sent you ${picked.length} messages from the PasserJack Agents page. The owner typed them for this session only. Do them in this order.`,
    "Act on it as on a line that the user typed here. Your standing instructions and the normal permission rules still apply.",
    `To answer the owner, use the PasserJack tool message_user${session} and the inReplyTo below. If you do not have that tool, answer here: the owner sees your last message on the Agents page.`,
  ];
  picked.forEach((m, index) => {
    lines.push("");
    lines.push(one ? "The message:" : `Message ${index + 1} of ${picked.length}:`);
    if (m.entryId) lines.push(`(inReplyTo: ${m.entryId})`);
    lines.push(m.body);
  });
  return lines.join("\n");
}

/** Record `ids` as delivered. The ledger keeps the newest `MAX_DELIVERED_IDS`. */
export function recordDelivered(state, ids) {
  const set = new Set(state.delivered);
  for (const id of ids) set.add(id);
  state.delivered = Array.from(set).slice(-MAX_DELIVERED_IDS);
  return state;
}

/** True when the waiter for event `n` may post: nothing happened since, and its wait is still the pending one. */
export function waiterMayPost(state, n) {
  return Boolean(state && state.counter === n && state.pending && state.pending.n === n);
}

/**
 * The body of `POST /api/sessions/<id>/state` for a pending wait (design 4.2):
 * `idle` with the last message (left out when it is switched off or empty),
 * or `waiting_permission` with the tool name only.
 */
export function stateBody(pending) {
  if (pending.state === "waiting_permission") {
    return pending.tool ? { state: "waiting_permission", tool: pending.tool } : { state: "waiting_permission" };
  }
  return pending.lastMessage ? { state: "idle", lastMessage: pending.lastMessage } : { state: "idle" };
}

/**
 * THE REQUEST POST (design 5.1 of
 * `docs/plans/2026-11-26-remote-permission/design.html`): the body of `POST
 * /api/sessions/<id>/state` for a prompt that waits for the owner's answer.
 * The server makes one permission row and its side row, idempotent by
 * `requestKey`, and pushes nothing at the insert. `toolInput` is the EXACT
 * input, or absent with `inputTooLong: true` (never a cut input), or absent
 * when the harness sent none. The bridge's harnesses send no session grant.
 */
export function requestBody({ requestKey, tool, input, inputTooLong }) {
  const body = { state: "waiting_permission", requestKey };
  if (tool) body.tool = tool;
  if (inputTooLong) body.inputTooLong = true;
  else if (typeof input === "string" && input.length > 0) body.toolInput = input;
  return body;
}

/*
 * A prompt with no sign of an answer for `PERMISSION_PUSH_AFTER_MS` (the
 * leaf's number, ONE copy in `../bin/hook-core.mjs`, imported above) asks the
 * server for one push.
 */

/** `PASSERJACK_BRIDGE_PUSH_MS` may bring the push nearer, only from 1 s up to the minute (a test seam). */
export function pushAfterMsFor(env) {
  const raw = (env?.PASSERJACK_BRIDGE_PUSH_MS ?? "").trim();
  if (!/^\d+$/.test(raw)) return PERMISSION_PUSH_AFTER_MS;
  const ms = Number(raw);
  return ms >= 1000 && ms <= PERMISSION_PUSH_AFTER_MS ? ms : PERMISSION_PUSH_AFTER_MS;
}

/*
 * The long poll's wait, in seconds (the server waits up to this long for a
 * change of the row), is `POLL_WAIT_S` of `../bin/hook-core.mjs`, the one copy
 * that the Claude Code hook polls with too.
 */

/** `PASSERJACK_BRIDGE_WAIT_MS` may shorten a permission wait, only inside these bounds (a test seam). */
export const MIN_PERMISSION_WAIT_MS = 1000;

/** The wait of a permission hook: the harness's own `max`, or `PASSERJACK_BRIDGE_WAIT_MS` when it is a whole number from 1 s up to `max`. */
export function permissionWaitFor(env, max) {
  const raw = (env?.PASSERJACK_BRIDGE_WAIT_MS ?? "").trim();
  if (!/^\d+$/.test(raw)) return max;
  const ms = Number(raw);
  return ms >= MIN_PERMISSION_WAIT_MS && ms <= max ? ms : max;
}

/* ------------------------------------------------------------------ */
/* D8: an environment key and the saved sign-in of different accounts. */
/* ------------------------------------------------------------------ */

/**
 * THE ACCOUNT CHECK (design D8 of the remote permission design; #787i). When
 * `PASSERJACK_API_KEY` is set AND a sign-in is saved for the same origin,
 * the two can belong to DIFFERENT accounts. Then the bridge does NOTHING: no
 * registration, no post, no message, no answer. A WORKER (it has the
 * network) asks `GET /api/me` with each and keeps the verdict in this file
 * in the state folder; a hook in the foreground reads only this file. The
 * file holds a hash of the two sign-ins' identities (`signInIdentity`, never a
 * token, never a key, never the bare hash of a key) and the verdict; a new
 * key or a new sign-in changes the hash, so an old verdict never counts.
 *
 * REMOTE ANSWERS NEED THE SAVED SIGN-IN: a prompt waits for the owner's
 * answer only when the bearer is the saved sign-in, or an environment key of
 * the same account. An environment key alone works for messages and status,
 * and gets no answers: a repository that sets the key cannot answer a prompt
 * on this computer from another account.
 */
// Not `.json`: the readers of the session state files (the watch's folder
// scan, the tests) take every `.json` in the folder for a session.
export const ACCOUNT_CHECK_FILE = "account-check.verdict";

/** The verdict file in the state folder. */
export function accountCheckPath(dir) {
  return path.join(dir, ACCOUNT_CHECK_FILE);
}

/** The hash that names one pair of sign-ins, or null when there are not two. */
export function accountInputs(envKey, saved) {
  if (!envKey || !saved) return null;
  return crypto
    .createHash("sha256")
    .update(`passerjack-account-check\0${signInIdentity({ kind: "env", key: envKey })}\0${signInIdentity(saved)}`)
    .digest("hex");
}

/** The verdict in `file`: `{ inputs, verdict }`, or null. Never throws. */
export function readAccountCheck(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value?.v !== 1 || typeof value.inputs !== "string" || (value.verdict !== "same" && value.verdict !== "mismatch")) return null;
    return { inputs: value.inputs, verdict: value.verdict };
  } catch {
    return null;
  }
}

/** Keep a verdict. Throws on failure. */
export function writeAccountCheck(file, inputs, verdict, now = Date.now()) {
  writeJsonAtomic(file, { v: 1, inputs, verdict, at: now });
}

/**
 * What the bridge may do with these credentials. `active`: it may register,
 * post and hand messages on. `remote`: a prompt may wait for the owner's
 * answer. `needsCheck`: there is no verdict yet for this pair, so a worker
 * must ask; until then the bridge does nothing (fail closed). `mismatch`: the
 * verdict is that the two are different accounts.
 *
 * @param {{ envKey: string | null, saved: object | null, check: { inputs: string, verdict: string } | null }} facts
 */
export function accountGate({ envKey, saved, check }) {
  if (!envKey) return { active: Boolean(saved), remote: Boolean(saved), needsCheck: false, mismatch: false };
  if (!saved) return { active: true, remote: false, needsCheck: false, mismatch: false };
  const inputs = accountInputs(envKey, saved);
  if (check && check.inputs === inputs) {
    const same = check.verdict === "same";
    return { active: same, remote: same, needsCheck: false, mismatch: !same };
  }
  return { active: false, remote: false, needsCheck: true, mismatch: false };
}
