#!/usr/bin/env node
/**
 * THE PASSERJACK AGENT BRIDGE: one program that the hooks of every agent
 * harness other than Claude Code run, so the owner's Agents page sees each
 * session, its finished turns and its open prompts, and a message the owner
 * types there reaches the session.
 *
 *   node bridge.mjs <harness> <event>      a hook: the event JSON on stdin
 *   node bridge.mjs watch <harness> [--session-key <id>]
 *                                          a monitor (Grok Build): one line
 *                                          per message for this session, in
 *                                          the Claude Code watcher's words
 *   node bridge.mjs --version
 *
 * `harnesses.mjs` turns each harness's payload into one shape and builds its
 * decision; `bridge-core.mjs` holds the rules and the state file. The
 * credential is the Claude Code plugin's (`../bin/credentials.mjs`): a key
 * in `PASSERJACK_API_KEY`, else the sign-in that `connect.mjs` saved, so one
 * computer has one PasserJack sign-in. The origin is pinned the same way
 * (`resolveOrigin`).
 *
 * WHAT A HOOK DOES, AND WHAT IT NEVER DOES. A hook is on the harness's
 * critical path (Grok Build kills an observe hook at 5 seconds), so the
 * foreground part reads its state, bumps the session's event counter, makes
 * AT MOST ONE short read (`GET /api/messages?session=`, only when it can hand
 * a message on in this same fire), prints the decision or nothing, and exits
 * 0. Everything else (the registration, the state posts, the minute of
 * silence, the ack, a token refresh) runs in a DETACHED WORKER, a copy of
 * this program with its stdio closed, so the harness never waits for it. A
 * token refresh NEVER runs in the foreground: a hook killed after the server
 * rotated the pair would leave a spent refresh token in the file, and the
 * next refresh would revoke the sign-in that the Claude Code plugin shares.
 *
 * OUTPUT DISCIPLINE. stdout carries the harness's decision and nothing else:
 * nothing at all when there is no decision (or `{}` where the harness parses
 * every stdout as JSON). Every failure is silent and exits 0. No line, here or
 * in a worker, ever prints a credential, a message or the last message,
 * except the decision payload itself, which IS the owner's message.
 */

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bearerOf,
  HOOK_TOKEN_MARGIN_MS,
  hookBearer,
  loadAuth,
  needsRefresh,
  readCredentials,
  renewCredential,
  requestRefresh,
  withLock,
  writeJsonAtomic,
} from "../bin/credentials.mjs";
import { startedAfter } from "../bin/hook-core.mjs";
import { childrenOf, findOnPath, processTable, safeCwd } from "../bin/programs.mjs";
import { trace as traceTo, TRACE_SWITCHES } from "../bin/trace.mjs";
import {
  BurstWindow,
  SseParser,
  backoffMs,
  burstLineFor,
  feedUrl,
  lineForFrame,
  resolveOrigin,
  resumeHeader,
  sessionBody,
  sessionIdFrom,
  IDLE_TIMEOUT_MS,
  MAX_RETRY_HINT_MS,
} from "../bin/watch-core.mjs";
import {
  ALIAS_DEPTH,
  ALIAS_START_SLACK_MS,
  ancestorAliasPath,
  aliasPath,
  claimRegistration,
  deliveryText,
  idleDelayMs,
  newState,
  pickOwnerMessages,
  pruneStates,
  readState,
  recordDelivered,
  shareLastMessage,
  stateBody,
  stateDir,
  statePath,
  transcriptSize,
  TRANSCRIPT_SETTLE_MS,
  waiterMayPost,
  writeState,
  ensureStateDir,
} from "./bridge-core.mjs";
import { harnessFor, normalize, promptDecision, reportsPermissionReply, silentOutput, turnEndDecision } from "./harnesses.mjs";

export const BRIDGE_VERSION = "0.1.0";

const SELF = fileURLToPath(import.meta.url);

/** The one read a foreground hook may make. Well under every harness's hook timeout. */
export const HOOK_READ_TIMEOUT_MS = 3000;

/** A network call made by a worker. */
const WORKER_REQUEST_TIMEOUT_MS = 10_000;

/** How long an ack that did not land waits before its one more try. */
export const ACK_RETRY_MS = 2000;

/** How long the foreground waits for the state lock before it gives up (silently). */
const STATE_LOCK_WAIT_MS = 1500;

/** A state lock older than this belongs to a process that died holding it. */
const STATE_LOCK_STALE_MS = 5000;

/** The largest hook payload read from stdin. A last message is at most a few tens of kB. */
const MAX_STDIN_BYTES = 4 * 1024 * 1024;

/** How long the foreground waits for stdin to end, for a harness that never closes it. */
const STDIN_WAIT_MS = 2000;


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function headers(token, extra = {}) {
  return { authorization: `Bearer ${token}`, "user-agent": `passerjack-agent-bridge/${BRIDGE_VERSION}`, ...extra };
}

/**
 * A closed-word trace for a live check (`../bin/trace.mjs`), written ONLY
 * when `PASSERJACK_BRIDGE_DEBUG` is exactly `1`, to `bridge-debug.log` in the
 * state folder: the harness, the event and what happened, in fixed words. No
 * text, no id, no token, no path.
 */
function trace(env, harness, event, outcome) {
  traceTo(env, TRACE_SWITCHES.bridge, path.join(stateDir(), "bridge-debug.log"), harness, event, outcome);
}

/** The closed word for a thrown value: its `code`, else its class. Never its message. */
function errorWord(err) {
  if (err && typeof err === "object" && typeof err.code === "string") return err.code;
  return err instanceof Error ? err.name : "error";
}

/** The token a worker uses: refreshed first when it is due, under the machine-wide lock. */
async function workerToken(auth) {
  if (!auth) return null;
  if (auth.kind === "env") return auth.key;
  let cred = readCredentials(auth.file) ?? auth.cred;
  if (needsRefresh(cred)) {
    const out = await renewCredential(auth.file, { staleToken: bearerOf(cred), refresh: (c) => requestRefresh(c) });
    if (out.kind !== "ok") return out.kind === "transient" && !needsRefresh(cred, Date.now() + HOOK_TOKEN_MARGIN_MS) ? bearerOf(cred) : null;
    cred = out.cred;
  }
  auth.cred = cred;
  return bearerOf(cred);
}

async function request(origin, route, { method = "GET", token, body, timeoutMs }) {
  const init = {
    method,
    headers: headers(token, body === undefined ? {} : { "content-type": "application/json" }),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(new URL(route, origin), init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    // Not JSON, or no body.
  }
  return { status: res.status, ok: res.ok, data };
}

/** Read stdin to its end, bounded in size and in time. "" when there is none. */
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, STDIN_WAIT_MS);
    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_STDIN_BYTES) {
        chunks.length = 0;
        finish();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Write `text` (maybe nothing) to stdout, and exit 0 once it is written. */
function finish(text) {
  if (!text) process.exit(0);
  process.stdout.write(text, () => process.exit(0));
}

/** Start a detached worker with its stdio closed. Its arguments carry no secret and no text. */
function spawnWorker(job, harnessId, file, extra = []) {
  try {
    const child = spawn(process.execPath, [SELF, "__worker", job, harnessId, file, ...extra], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    child.unref();
  } catch {
    // No worker: the next event tries again.
  }
}

const lock = (file, fn) => withLock(file, fn, { staleMs: STATE_LOCK_STALE_MS, waitMs: STATE_LOCK_WAIT_MS });

/** The state of one session, read and changed under its lock. */
async function changeState(file, harnessId, fn) {
  return lock(file, async () => {
    const state = readState(file, harnessId) ?? newState(harnessId);
    const out = await fn(state);
    state.updatedAt = Date.now();
    writeState(file, state);
    return out;
  });
}

/**
 * The owner messages waiting for this session, or a closed word: `gone` (the
 * server no longer knows the session: register again), `refused` (the token:
 * a worker refreshes), `unreachable`.
 */
async function ownerMessages(origin, token, sessionId) {
  try {
    // `peek=1`: the read stamps nothing; the ack, once the text is handed on, does.
    const res = await request(origin, `/api/messages?session=${encodeURIComponent(sessionId)}&peek=1`, {
      token,
      timeoutMs: HOOK_READ_TIMEOUT_MS,
    });
    if (res.status === 400) return "gone";
    if (res.status === 401) return "refused";
    if (!res.ok || !res.data || !Array.isArray(res.data.messages)) return "unreachable";
    return res.data.messages;
  } catch {
    return "unreachable";
  }
}

/** The key of a session whose event carries none (Junie's Stop): the one its parent process recorded. */
function aliasedKey(dir, harnessId) {
  try {
    const text = fs.readFileSync(aliasPath(dir, harnessId, process.ppid), "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

function writeAlias(dir, harnessId, key) {
  try {
    ensureStateDir(dir);
    fs.writeFileSync(aliasPath(dir, harnessId, process.ppid), `${key}\n`, { mode: 0o600 });
  } catch {
    // No alias: the session's later events find no key and do nothing.
  }
}

/**
 * The processes above this one, nearest first, up to `ALIAS_DEPTH`, each
 * with its start time (from `ps`'s age), or null with no process table.
 */
async function ancestorsWithStart() {
  const table = await processTable();
  if (!table) return null;
  const rows = new Map(table.map((row) => [row.pid, row]));
  const now = Date.now();
  const out = [];
  let at = rows.get(process.pid)?.ppid;
  while (out.length < ALIAS_DEPTH && at && at > 1) {
    const row = rows.get(at);
    if (!row) break;
    out.push({ pid: at, startedAt: now - row.elapsedMs });
    at = row.ppid;
  }
  return out;
}

/** Session start of a harness whose monitor may have no session id (Grok Build): an alias on each process above the hook. */
async function writeAncestorAliases(dir, harnessId, key) {
  const above = await ancestorsWithStart();
  for (const { pid, startedAt } of above ?? []) {
    try {
      writeJsonAtomic(ancestorAliasPath(dir, harnessId, pid), { v: 1, key, pid, startedAt });
    } catch {
      // No alias: the watch falls back to the one session of its folder.
    }
  }
}

/**
 * The session key of a watch with no session id: the alias of the nearest
 * process above it that is the SAME process (same start time) as the one the
 * alias was written for. `table: false` when there is no process table.
 */
async function keyByAncestor(dir, harnessId) {
  const above = await ancestorsWithStart();
  if (!above) return { table: false, key: null };
  for (const { pid, startedAt } of above) {
    try {
      const alias = JSON.parse(fs.readFileSync(ancestorAliasPath(dir, harnessId, pid), "utf8"));
      if (alias?.v !== 1 || alias.pid !== pid || typeof alias.key !== "string" || !alias.key) continue;
      if (!Number.isFinite(alias.startedAt) || Math.abs(alias.startedAt - startedAt) > ALIAS_START_SLACK_MS) continue;
      return { table: true, key: alias.key };
    } catch {
      // No alias for this one: look higher.
    }
  }
  return { table: true, key: null };
}

/**
 * Try to hand waiting owner messages on in THIS fire. Records them as
 * delivered before it answers, so a crash between the record and the print
 * can lose a delivery but never repeat one. Answers the decision text, or null.
 *
 * `confirm` (a shim whose program can refuse the text: opencode's prompt):
 * the decision carries the ids, and the ack waits for the shim's `delivered`
 * answer; a refusal takes the ids out of the ledger, so the next turn end
 * hands them on again.
 */
async function handOn(ctx, file, decide, confirm = false) {
  const { origin, token, harnessId, env } = ctx;
  const before = readState(file, harnessId);
  if (!before?.sessionId || !token) return null;
  const messages = await ownerMessages(origin, token, before.sessionId);
  if (messages === "gone") {
    const ask = await changeState(file, harnessId, (s) => {
      s.sessionId = null;
      s.registerAt = 0;
      return claimRegistration(s);
    }).catch(() => false);
    if (ask) spawnWorker("register", harnessId, file);
    trace(env, harnessId, ctx.event, "session-gone");
    return null;
  }
  if (messages === "refused") {
    spawnWorker("refresh", harnessId, file);
    trace(env, harnessId, ctx.event, "token-refused");
    return null;
  }
  if (messages === "unreachable") {
    trace(env, harnessId, ctx.event, "unreachable");
    return null;
  }
  const out = await changeState(file, harnessId, (s) => {
    const picked = pickOwnerMessages(messages, s.delivered);
    if (!picked.length) return null;
    const ids = picked.map((m) => m.id);
    const text = decide(deliveryText(picked, s.sessionId), confirm ? ids : null);
    if (!text) return null;
    recordDelivered(s, ids);
    s.turnDeliveries += 1;
    s.wait = null;
    s.pending = null;
    return { ids, text };
  });
  if (!out) return null;
  const keys = Object.keys(parseJson(out.text) ?? {}).join(",") || "none";
  trace(env, harnessId, ctx.event, `decision keys=${keys} chars=${out.text.length}`);
  // The read was a peek: the ack stamps the message as handled. It is best
  // effort (the ledger already keeps the delivery single), and for a shim
  // that confirms it waits for the shim's `delivered`.
  if (!confirm) spawnWorker("ack", harnessId, file, out.ids);
  trace(env, harnessId, ctx.event, `delivered-${out.ids.length}`);
  return out.text;
}

/** One hook event. Always resolves to what stdout gets (maybe nothing). */
async function runHook(harnessId, eventArg, env) {
  const harness = harnessFor(harnessId);
  if (!harness) return "";
  const silent = silentOutput(harnessId);
  const raw = parseJson(await readStdin());
  const n = normalize(harnessId, eventArg, raw);
  if (!n) {
    trace(env, harnessId, String(eventArg).slice(0, 40).replace(/[^A-Za-z0-9_.-]/g, "?"), "ignored");
    return silent;
  }
  trace(
    env,
    harnessId,
    n.event,
    `normalized from=${String(eventArg).replace(/[^A-Za-z0-9_.-]/g, "?")} key=${n.sessionKey ? "yes" : "no"} cwd=${n.cwd ? "yes" : "no"} last=${n.lastMessage ? "yes" : "no"} tool=${n.tool ?? "none"} stopActive=${n.stopActive}`,
  );
  const origin = resolveOrigin(env);
  if (!origin.ok) return silent;
  const auth = loadAuth(env, origin.origin);
  if (!auth) {
    trace(env, harnessId, n.event, "no-sign-in");
    return silent;
  }
  const dir = stateDir();
  let key = n.sessionKey;
  if (!key && harness.aliasByParent) key = aliasedKey(dir, harnessId);
  if (!key) return silent;
  if (n.sessionKey && harness.aliasByParent && n.event === "session_start") writeAlias(dir, harnessId, key);
  if (n.sessionKey && harness.aliasByAncestor && n.event === "session_start") await writeAncestorAliases(dir, harnessId, key);
  const file = statePath(dir, harnessId, key);
  const cwd = n.cwd ?? process.cwd();
  const token = hookBearer(auth);
  if (!token) spawnWorker("refresh", harnessId, file);
  const ctx = { origin: origin.origin, token, harnessId, env, event: n.event };

  if (n.event === "last_text") {
    await changeState(file, harnessId, (s) => {
      s.lastText = n.lastMessage;
    });
    return silent;
  }

  if (n.event === "session_start") {
    const ask = await changeState(file, harnessId, (s) => {
      s.cwd = cwd;
      s.counter += 1;
      // A new session start (a resume, a /clear) registers again: same clientId, same row.
      s.registerAt = 0;
      return claimRegistration(s);
    });
    if (ask) spawnWorker("register", harnessId, file);
    trace(env, harnessId, n.event, "register");
    return silent;
  }

  if (n.event === "session_end") {
    // NOT a DELETE of the PasserJack session: ending it would cascade its
    // Agents page thread away (design C6), with the last reply the owner has
    // not read yet, and Codex fires SessionEnd after 30 idle minutes too. The
    // session goes quiet on its own and expires a day later; the state file
    // (and its delivery ledger) stays for a resume.
    await changeState(file, harnessId, (s) => {
      s.counter += 1;
      s.pending = null;
    });
    trace(env, harnessId, n.event, "quiet");
    return silent;
  }

  if (n.event === "delivered") {
    // A confirming shim's answer. Only ids that this session's ledger holds count.
    const ids = await changeState(file, harnessId, (s) => {
      const mine = n.ids.filter((id) => s.delivered.includes(id));
      if (!n.ok && mine.length) {
        s.delivered = s.delivered.filter((id) => !mine.includes(id));
        s.turnDeliveries = Math.max(0, s.turnDeliveries - 1);
      }
      return mine;
    });
    if (n.ok && ids.length) spawnWorker("ack", harnessId, file, ids);
    trace(env, harnessId, n.event, `${n.ok ? "taken" : "refused"}-${ids.length}`);
    return silent;
  }

  if (n.event === "resolved") {
    const had = await changeState(file, harnessId, (s) => {
      s.counter += 1;
      s.pending = null;
      const open = s.wait;
      s.wait = null;
      return open;
    });
    if (had) spawnWorker("working", harnessId, file);
    trace(env, harnessId, n.event, had ? "working" : "resolved");
    return silent;
  }

  if (n.event === "prompt") {
    const openWait = await changeState(file, harnessId, (s) => {
      s.cwd ??= cwd;
      s.counter += 1;
      s.turnDeliveries = 0;
      s.pending = null;
      s.lastText = null;
      const had = s.wait;
      s.wait = null;
      return { had, register: claimRegistration(s) };
    });
    if (openWait.had) spawnWorker("working", harnessId, file);
    if (openWait.register) spawnWorker("register", harnessId, file);
    if (harness.ride) {
      const text = await handOn(ctx, file, (body) => promptDecision(harnessId, body));
      if (text) return text;
    }
    trace(env, harnessId, n.event, openWait.had ? "working" : "prompt");
    return silent;
  }

  if (n.event === "permission" || n.event === "question") {
    const counter = await changeState(file, harnessId, (s) => {
      s.cwd ??= cwd;
      s.counter += 1;
      // `parent`: the harness (this hook's parent). An approved tool that runs
      // is a new child of it, which the waiter looks for at the minute.
      s.pending = { n: s.counter, at: Date.now(), state: "waiting_permission", tool: n.tool, lastMessage: null, transcript: n.transcript, parent: process.ppid };
      return s.counter;
    });
    spawnWorker("wait", harnessId, file, [String(counter)]);
    trace(env, harnessId, n.event, "wait");
    return silent;
  }

  if (n.event === "turn_end" || n.event === "wake") {
    const view = await changeState(file, harnessId, (s) => {
      s.cwd ??= cwd;
      if (n.event === "wake" || (!n.stopActive && (n.loopCount === null || n.loopCount === 0))) s.turnDeliveries = 0;
      return { register: claimRegistration(s), mayDeliver: harness.deliver !== "none" && s.turnDeliveries < harness.cap };
    });
    if (view.register) spawnWorker("register", harnessId, file);
    if (view.mayDeliver) {
      const text = await handOn(ctx, file, (body, ids) => turnEndDecision(harnessId, body, ids), n.confirm && harness.deliver === "shim");
      if (text) return text;
    }
    if (n.event === "wake") return silent;
    // Nothing handed on: the turn ended and waits on the user, unless other
    // background work will wake it. Post after a minute in which nothing happened.
    const share = shareLastMessage(env);
    const counter = await changeState(file, harnessId, (s) => {
      s.counter += 1;
      const lastMessage = n.lastMessage ?? s.lastText;
      s.lastText = null;
      s.pending = n.busyBackground
        ? null
        : { n: s.counter, at: Date.now(), state: "idle", lastMessage: share ? lastMessage : null, tool: null, transcript: n.transcript };
      return s.pending ? s.counter : null;
    });
    if (counter !== null) spawnWorker("wait", harnessId, file, [String(counter)]);
    trace(env, harnessId, n.event, counter !== null ? "wait" : "busy-background");
    return silent;
  }
  return silent;
}

/* ------------------------------------------------------------------ */
/* Workers: detached, stdio closed, each bounded.                       */
/* ------------------------------------------------------------------ */

function git(gitPath, cwd, args) {
  return new Promise((resolve) => {
    if (!gitPath || !cwd) return resolve(null);
    execFile(
      gitPath,
      ["-C", cwd, ...args],
      { timeout: 2000, windowsHide: true, encoding: "utf8", cwd: safeCwd(process.platform, process.env) },
      (err, stdout) => resolve(err ? null : String(stdout ?? "").trim() || null),
    );
  });
}

/** Register (or re-register: same clientId, same row) and save the id. Answers the id or null. */
async function register(ctx, file) {
  const state = readState(file, ctx.harnessId);
  if (!state) return null;
  const token = await workerToken(ctx.auth);
  if (!token) return null;
  const gitPath = findOnPath("git", { env: process.env, platform: process.platform });
  const cwd = state.cwd && path.isAbsolute(state.cwd) ? state.cwd : null;
  const [remote, branch] = await Promise.all([
    git(gitPath, cwd, ["remote", "get-url", "origin"]),
    git(gitPath, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  // `sessionBody` reduces every fact before it leaves (the folder to its last
  // segment, the remote to owner/name); it names Claude Code, so the harness
  // is set after it.
  const body = {
    ...sessionBody(ctx.env, { hostname: os.hostname(), cwd, remote, branch, clientId: state.clientId }),
    harness: harnessFor(ctx.harnessId).reported,
    // True where the bridge reports this harness's turn ends (design C9).
    waits: harnessFor(ctx.harnessId).waits !== false,
  };
  let res;
  try {
    res = await request(ctx.origin, "/api/sessions", { method: "POST", token, body, timeoutMs: WORKER_REQUEST_TIMEOUT_MS });
  } catch {
    return null;
  }
  const id = res.ok ? sessionIdFrom(res.data) : null;
  if (!id) return null;
  await changeState(file, ctx.harnessId, (s) => {
    s.sessionId = id;
  });
  return id;
}

async function postState(ctx, sessionId, body) {
  const token = await workerToken(ctx.auth);
  if (!token) return "refused";
  try {
    const res = await request(ctx.origin, `/api/sessions/${sessionId}/state`, {
      method: "POST",
      token,
      body,
      timeoutMs: WORKER_REQUEST_TIMEOUT_MS,
    });
    if (res.ok) return "ok";
    if (res.status === 404) return "gone";
    return "refused";
  } catch {
    return "unreachable";
  }
}

/** Post, registering again once when the server says the session is gone. */
async function postWithRegistration(ctx, file, body) {
  let sessionId = readState(file, ctx.harnessId)?.sessionId ?? (await register(ctx, file));
  if (!sessionId) return "unregistered";
  let out = await postState(ctx, sessionId, body);
  if (out === "gone") {
    await changeState(file, ctx.harnessId, (s) => {
      s.sessionId = null;
    });
    sessionId = await register(ctx, file);
    if (!sessionId) return "unregistered";
    out = await postState(ctx, sessionId, body);
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runWorker(job, harnessId, file, extra, env) {
  if (!harnessFor(harnessId) || path.dirname(file) !== stateDir()) return;
  const origin = resolveOrigin(env);
  if (!origin.ok) return;
  const auth = loadAuth(env, origin.origin);
  if (!auth) return;
  const ctx = { origin: origin.origin, auth, harnessId, env };

  if (job === "refresh") {
    await workerToken(auth);
    return;
  }
  if (job === "register") {
    pruneStates(stateDir());
    const id = await register(ctx, file);
    trace(env, harnessId, "worker", id ? "registered" : "register-failed");
    return;
  }
  if (job === "working") {
    const out = await postWithRegistration(ctx, file, { state: "working" });
    trace(env, harnessId, "worker", `working-${out}`);
    return;
  }
  if (job === "ack") {
    const sessionId = readState(file, harnessId)?.sessionId;
    if (!sessionId) return;
    for (const id of extra.filter((value) => UUID_RE.test(value))) {
      // Best effort, the ledger keeps the delivery single, but an ack that
      // does not land leaves the owner's message unhandled on the Agents page
      // (the read was a peek): one more try after a short wait for no
      // answer, a 5xx, a 429 or a refused token. A 403 or a 404 is final.
      let status = "unreachable";
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt > 0) await sleep(ACK_RETRY_MS);
        const token = await workerToken(auth);
        if (!token) {
          status = "no-token";
          continue;
        }
        try {
          const res = await request(origin.origin, `/api/messages/${id}?session=${sessionId}`, {
            method: "DELETE",
            token,
            timeoutMs: WORKER_REQUEST_TIMEOUT_MS,
          });
          status = String(res.status);
          if (res.ok || res.status === 403 || res.status === 404) break;
        } catch {
          status = "unreachable";
        }
      }
      trace(env, harnessId, "worker", `ack-${status}`);
    }
    return;
  }
  if (job === "wait") {
    const n = Number(extra[0]);
    if (!Number.isSafeInteger(n)) return;
    const first = readState(file, harnessId);
    if (!waiterMayPost(first, n)) return;
    const due = first.pending.at + idleDelayMs(env);
    // The size of the transcript after a short settle is the baseline: a
    // transcript that grows during the minute means the session moved (a
    // permission approved and its tool running, a new turn), even where no
    // hook said so. Only the size is read.
    let baseline = null;
    if (first.pending.transcript) {
      await sleep(Math.min(TRANSCRIPT_SETTLE_MS, Math.max(0, due - Date.now())));
      baseline = transcriptSize(first.pending.transcript);
    }
    await sleep(Math.max(0, due - Date.now()));
    if (baseline !== null) {
      const now = transcriptSize(first.pending.transcript);
      if (now !== null && now > baseline) {
        trace(env, harnessId, "worker", "wait-transcript-moved");
        return;
      }
    }
    // A prompt that was approved, whose tool still runs and writes nothing to
    // the transcript: the tool is a child of the harness that started after
    // the prompt (the Claude Code plugin's test, `startedAfter`). A harness
    // that has exited (a shell that wrapped the hook) has no children here,
    // and the test then says nothing. No `ps` (Windows): the transcript alone.
    // NOT for a harness that reports the person's answer itself (opencode and
    // Kilo Code: `permission_replied` resolves the wait): there the prompt is
    // still open at the minute by construction, so any child it finds (a
    // parallel subagent's watch, a language server that started late) is a
    // false "approved", and a real prompt's push was missed (/dcr wave 2).
    if (first.pending.state === "waiting_permission" && first.pending.parent && !reportsPermissionReply(harnessId)) {
      const kids = await childrenOf(first.pending.parent);
      const checkedAt = Date.now();
      if (kids && kids.some((child) => startedAfter(child, first.pending.at, checkedAt))) {
        trace(env, harnessId, "worker", "wait-child-started");
        return;
      }
    }
    // Claim the wait under the lock, so a prompt that comes after this point
    // sees an open wait and posts `working`.
    const pending = await lock(file, async () => {
      const state = readState(file, harnessId);
      if (!waiterMayPost(state, n)) return null;
      const claimed = state.pending;
      state.wait = claimed.state;
      state.pending = null;
      state.updatedAt = Date.now();
      writeState(file, state);
      return claimed;
    }).catch(() => null);
    if (!pending) {
      trace(env, harnessId, "worker", "wait-superseded");
      return;
    }
    const out = await postWithRegistration(ctx, file, stateBody(pending));
    trace(env, harnessId, "worker", `${pending.state}-${out}`);
  }
}

/* ------------------------------------------------------------------ */
/* Watch mode: the monitor that wakes an idle session (Grok Build).     */
/* ------------------------------------------------------------------ */

/**
 * The state file of the session this monitor belongs to: by its session id;
 * else (Grok Build with no `GROK_SESSION_ID`) by the alias of the process
 * above it (`keyByAncestor`); else the ONE session of this harness in this
 * folder. Two sessions in one folder and no alias: none, and the watch waits,
 * because the newest of two would cross-wire two terminals.
 */
async function findWatchedState(harnessId, sessionKey, cwd) {
  const dir = stateDir();
  if (sessionKey) {
    const file = statePath(dir, harnessId, sessionKey);
    return readState(file, harnessId) ? file : null;
  }
  if (harnessFor(harnessId)?.aliasByAncestor) {
    const found = await keyByAncestor(dir, harnessId);
    if (found.key) {
      const file = statePath(dir, harnessId, found.key);
      return readState(file, harnessId) ? file : null;
    }
  }
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }
  const here = realpath(cwd);
  const since = Date.now() - WATCH_FALLBACK_MAX_AGE_MS;
  const matches = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const state = readState(file, harnessId);
    if (state && state.cwd && state.updatedAt >= since && realpath(state.cwd) === here) matches.push(file);
  }
  return matches.length === 1 ? matches[0] : null;
}

/** A session of the folder not heard from for this long is not a candidate for a watch with no id: its row has expired. */
const WATCH_FALLBACK_MAX_AGE_MS = 24 * 60 * 60_000;

function realpath(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

function argValue(args, name) {
  const at = args.indexOf(name);
  return at >= 0 && typeof args[at + 1] === "string" ? args[at + 1] : null;
}

/** How often a watch checks that the program that started it is still there. */
export const PARENT_CHECK_MS = 5000;

/**
 * A watch ends with the program that started it. opencode does not always
 * stop its plugin's children when it exits, and an orphaned watch would hold
 * the session's doorbell (the Agents page would say a watcher listens) and
 * reconnect forever. The parent is gone when this process was handed to
 * another parent, or when a signal 0 to it fails. A watch whose parent is
 * process 1 from the start does no check: in a container the harness itself
 * can be process 1, and a watch that is already an orphan cannot tell.
 */
function exitWithParent() {
  const parent = process.ppid;
  if (!parent || parent === 1) return;
  const timer = setInterval(() => {
    let alive = process.ppid === parent;
    if (alive) {
      try {
        process.kill(parent, 0);
      } catch (err) {
        alive = err?.code === "EPERM";
      }
    }
    if (!alive) process.exit(0);
  }, PARENT_CHECK_MS);
  timer.unref();
}

async function runWatch(harnessId, args, env) {
  const print = (line) => process.stdout.write(`${line}\n`);
  if (!harnessFor(harnessId)) return;
  exitWithParent();
  const origin = resolveOrigin(env);
  if (!origin.ok) return print(origin.line);
  const sessionKey = argValue(args, "--session-key") ?? (harnessId === "grok" ? (env.GROK_SESSION_ID ?? "").trim() || null : null);
  const lane = { kind: "messages", to: null };
  const burst = new BurstWindow(print, (n) => burstLineFor(lane, n), (fn, ms) => setTimeout(fn, ms).unref());
  let lastEventId = "";
  let attempt = 0;
  for (;;) {
    const auth = loadAuth(env, origin.origin);
    const file = auth ? await findWatchedState(harnessId, sessionKey, process.cwd()) : null;
    const sessionId = file ? readState(file, harnessId)?.sessionId : null;
    if (!auth || !file || !sessionId) {
      // The hooks register the session; wait for them, quietly.
      if (file && !sessionId) {
        const ask = await changeState(file, harnessId, (s) => claimRegistration(s)).catch(() => false);
        if (ask) spawnWorker("register", harnessId, file);
      }
      await sleep(3000);
      continue;
    }
    const token = await workerToken(auth);
    if (!token) {
      await sleep(backoffMs(attempt++));
      continue;
    }
    const controller = new AbortController();
    let idle = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
    let healthy = false;
    let retry = null;
    try {
      const h = headers(token, { accept: "text/event-stream" });
      const cursor = resumeHeader(lastEventId);
      if (cursor !== null) h["last-event-id"] = cursor;
      const res = await fetch(feedUrl(origin.origin, lane, sessionId), { headers: h, signal: controller.signal, redirect: "error" });
      if (res.status === 400) {
        // The session is gone: the hooks' next event, or this worker, registers again.
        await res.body?.cancel().catch(() => {});
        const ask = await changeState(file, harnessId, (s) => {
          if (s.sessionId === sessionId) {
            s.sessionId = null;
            s.registerAt = 0;
          }
          return claimRegistration(s);
        }).catch(() => false);
        if (ask) spawnWorker("register", harnessId, file);
        await sleep(backoffMs(attempt++));
        continue;
      }
      if (!res.ok || !res.body || !(res.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
        await res.body?.cancel().catch(() => {});
        if (res.status === 401) spawnWorker("refresh", harnessId, file);
        await sleep(backoffMs(attempt++));
        continue;
      }
      const parser = new SseParser(lastEventId);
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(idle);
        idle = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
        for (const record of parser.push(decoder.decode(value, { stream: true }))) {
          if (record.type === "retry") {
            if (healthy) retry = Math.min(record.ms, MAX_RETRY_HINT_MS);
            continue;
          }
          healthy = true;
          const out = lineForFrame(lane, record, sessionId);
          if (!out) continue;
          if (out.kind === "catchup") print(out.line);
          else burst.ring(out.line);
        }
        lastEventId = parser.lastEventId;
      }
    } catch {
      // A network error or the idle watchdog: reconnect below.
    } finally {
      clearTimeout(idle);
    }
    if (healthy) attempt = 0;
    await sleep(retry ?? backoffMs(attempt++));
  }
}

/* ------------------------------------------------------------------ */

/**
 * The origin the setup script installed for (`origin.txt` beside `bin/` and
 * `bridge/`, written only for a deployment other than passerjack.com), unless
 * `PASSERJACK_ORIGIN` is set. `resolveOrigin` pins either one.
 */
export function withInstalledOrigin(env, self = SELF) {
  if ((env.PASSERJACK_ORIGIN ?? "").trim()) return env;
  try {
    const origin = fs.readFileSync(path.join(path.dirname(self), "..", "origin.txt"), "utf8").trim();
    return origin ? { ...env, PASSERJACK_ORIGIN: origin } : env;
  } catch {
    return env;
  }
}

export async function main(argv = process.argv.slice(2), baseEnv = process.env) {
  const env = withInstalledOrigin(baseEnv);
  const [first, ...rest] = argv;
  if (first === "--version") {
    process.stdout.write(`${BRIDGE_VERSION}\n`);
    return;
  }
  if (first === "__worker") {
    const [job, harnessId, file, ...extra] = rest;
    await runWorker(job, harnessId, file, extra, env).catch((err) => {
      trace(env, String(harnessId), "worker", `worker-${String(job).slice(0, 20)}-threw ${errorWord(err)}`);
    });
    process.exit(0);
  }
  if (first === "watch") {
    const [harnessId, ...args] = rest;
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => process.exit(0));
    await runWatch(harnessId, args, env);
    return;
  }
  const [eventArg] = rest;
  let out = silentOutput(first);
  try {
    out = await runHook(first, eventArg, env);
  } catch (err) {
    // Silent on every failure: the harness goes on as if there were no hook.
    trace(env, String(first), String(eventArg), `hook-threw ${errorWord(err)}`);
  }
  finish(out);
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch(() => process.exit(0));
}
