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
 * THE ONE DOCUMENTED EXCEPTION: A PERMISSION PROMPT THAT WAITS FOR THE OWNER
 * (design `docs/plans/2026-11-26-remote-permission/design.html`, sections 3
 * and 8). The hook of a harness whose prompt the owner can answer from
 * PasserJack (`permissionTier` of `harnesses.mjs`) stays in the foreground
 * and waits for the answer:
 *   - a waiting-first harness (`away`: Codex) makes its ONE read, the
 *     session's "I'm away" switch (the poll route with `wait=0`, 3 s). Off:
 *     the harness's "no decision" at once, and the old minute of silence.
 *     On: it posts the request and waits, inside the hook timeout that the
 *     setup script installs, then prints the harness's own allow or deny;
 *   - a shim (`always`: opencode) is started by its plugin as a WAITER that
 *     the program never waits for, and prints `{ reply }` for the plugin.
 * The wait re-reads the credentials file at each poll and NEVER refreshes a
 * token (a worker does). Every error is "no decision". The tool's input
 * stays in this process's memory and goes only into the one request post. A
 * detached guard worker closes the request (`gone`) when this process is
 * killed. Remote answers need the saved sign-in (`accountGate`, design D8).
 *
 * OUTPUT DISCIPLINE. stdout carries the harness's decision and nothing else:
 * nothing at all when there is no decision (or `{}` where the harness parses
 * every stdout as JSON). Every failure is silent and exits 0, except a
 * permission hook whose harness reads exit 0 as an approval (Junie): that
 * hook exits 1 on every path that is not the owner's Allow (`hookExitFor`).
 * No line, here or in a worker, ever prints a credential, a message, the last
 * message, a tool input or a deny note, except the decision payload itself,
 * which IS the owner's answer.
 */

import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bearerOf,
  credentialsPath,
  HOOK_TOKEN_MARGIN_MS,
  hookBearer,
  loadAuth,
  needsRefresh,
  readAccount,
  readCredentials,
  renewCredential,
  requestRefresh,
  withLock,
  writeJsonAtomic,
} from "../bin/credentials.mjs";
import { askOwner, denyMessage, POLL_MARGIN_MS, startedAfter } from "../bin/hook-core.mjs";
import { childrenOf, findOnPath, processTable, safeCwd } from "../bin/programs.mjs";
import { trace as traceTo, TRACE_SWITCHES } from "../bin/trace.mjs";
import {
  ACCOUNTS_DIFFER_LINE,
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
  accountCheckPath,
  accountGate,
  accountInputs,
  ancestorAliasPath,
  aliasPath,
  claimRegistration,
  deliveryText,
  idleDelayMs,
  newState,
  permissionWaitFor,
  pushAfterMsFor,
  pickOwnerMessages,
  pruneStates,
  readAccountCheck,
  readState,
  recordDelivered,
  requestBody,
  shareLastMessage,
  stateBody,
  stateDir,
  statePath,
  transcriptSize,
  TRANSCRIPT_SETTLE_MS,
  waiterMayPost,
  writeAccountCheck,
  writeState,
  ensureStateDir,
} from "./bridge-core.mjs";
import {
  harnessFor,
  hookExitFor,
  normalize,
  permissionDecision,
  permissionTier,
  permissionWaitMs,
  promptDecision,
  reportsPermissionReply,
  SHIM_PERMISSION_WAIT_MS,
  silentOutput,
  turnEndDecision,
} from "./harnesses.mjs";

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

/** How often a guard worker checks that the process that waits for the owner is still there. */
const GUARD_CHECK_MS = 2000;

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

/** Write `text` (maybe nothing) to stdout, and exit with `code` (0 but for Junie's "no decision") once it is written. */
function finish(text, code = 0) {
  if (!text) process.exit(code);
  process.stdout.write(text, () => process.exit(code));
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

/* ------------------------------------------------------------------ */
/* D8: the environment's key and the saved sign-in (`accountGate`).     */
/* ------------------------------------------------------------------ */

/**
 * The two credentials of the account check: `PASSERJACK_API_KEY`, and the
 * sign-in saved for `origin` (the file that `loadAuth` does not read when the
 * key is set). Reads the file; never the network.
 */
function credentialFacts(env, origin) {
  const envKey = (env?.PASSERJACK_API_KEY ?? "").trim() || null;
  const cred = readCredentials(credentialsPath());
  return { envKey, saved: cred && cred.origin === origin ? cred : null };
}

/** The gate from the verdict file only: what a hook in the foreground may use. */
function gateNow(env, origin) {
  const facts = credentialFacts(env, origin);
  return { ...facts, ...accountGate({ ...facts, check: readAccountCheck(accountCheckPath(stateDir())) }) };
}

/**
 * The gate, after this WORKER asked `GET /api/me` with each credential when
 * no verdict covers the pair. ONE COPY of the account read: `readAccount` of
 * `../bin/credentials.mjs`, the Claude Code watcher's (one `GET /api/me`, no
 * redirect, a 10 s bound). Only an `ok` answer is an account; a refusal or a
 * failed read keeps no verdict: the gate stays closed and the next worker
 * asks again.
 */
async function checkedGate(env, origin) {
  const gate = gateNow(env, origin);
  if (!gate.needsCheck) return gate;
  const savedToken = await workerToken({ kind: gate.saved.kind, cred: gate.saved, file: credentialsPath() }).catch(() => null);
  if (!gate.envKey || !savedToken) return gate;
  const asBridge = { userAgent: `passerjack-agent-bridge/${BRIDGE_VERSION}` };
  const [envRead, savedRead] = await Promise.all([readAccount(origin, gate.envKey, asBridge), readAccount(origin, savedToken, asBridge)]);
  if (envRead.kind !== "ok" || savedRead.kind !== "ok") return gate;
  try {
    writeAccountCheck(accountCheckPath(stateDir()), accountInputs(gate.envKey, gate.saved), envRead.id === savedRead.id ? "same" : "mismatch");
  } catch {
    return gate;
  }
  return gateNow(env, origin);
}

/* ------------------------------------------------------------------ */
/* Permission requests: the doors of design 5.1.                        */
/* ------------------------------------------------------------------ */

const POLL_STATES = new Set(["open", "allowed", "denied", "closed", "unknown"]);

/**
 * One read of a request row: `GET /api/sessions/<id>/permissions/<key>?wait=`.
 * `{ kind: "answer", state, away, note }` (`away` true, false, or null when
 * the server did not send it), or `gone` (404: the session is
 * not this credential's any more), `refused` (401), `busy` (503 or 429,
 * with the server's `retry-after`), `unreachable`. Never the input.
 */
async function pollRequest(origin, token, sessionId, key, waitS, timeoutMs) {
  try {
    const init = { method: "GET", headers: headers(token), redirect: "error", signal: AbortSignal.timeout(timeoutMs) };
    const res = await fetch(new URL(`/api/sessions/${sessionId}/permissions/${key}?wait=${waitS}`, origin), init);
    if (res.status === 404) return { kind: "gone" };
    if (res.status === 401) return { kind: "refused" };
    // 503 while the replica drains; 429 at the server's poll cap. Both carry `retry-after`.
    if (res.status === 503 || res.status === 429) {
      const after = Number(res.headers.get("retry-after"));
      await res.body?.cancel().catch(() => {});
      return { kind: "busy", retryMs: Number.isFinite(after) && after > 0 ? after * 1000 : 5000 };
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      // Not JSON.
    }
    if (!res.ok || !data || !POLL_STATES.has(data.state)) return { kind: "unreachable" };
    // `away` is optional in the design's answer: true, false, or null for not sent.
    return { kind: "answer", state: data.state, away: typeof data.away === "boolean" ? data.away : null, note: typeof data.note === "string" ? data.note : null };
  } catch {
    return { kind: "unreachable" };
  }
}

/**
 * One request of a waiting hook to its session, for `askOwner` of
 * `../bin/hook-core.mjs` (the ONE copy of the request and wait protocol):
 * `{ status, answer, retryAfterMs }`, `status` 0 for no answer (no token, the
 * network, the timeout), `answer` the JSON body or null. Never a redirect.
 */
async function sessionRequest(origin, token, method, route, body, timeoutMs) {
  if (!token) return { status: 0, answer: null, retryAfterMs: null };
  try {
    const init = { method, headers: headers(token, body === undefined ? {} : { "content-type": "application/json" }), redirect: "error", signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(new URL(route, origin), init);
    let answer = null;
    try {
      answer = await res.json();
    } catch {
      // Not JSON, or no body.
    }
    const after = Number(res.headers.get("retry-after"));
    return { status: res.status, answer, retryAfterMs: Number.isFinite(after) && after > 0 ? after * 1000 : null };
  } catch {
    return { status: 0, answer: null, retryAfterMs: null };
  }
}

/** `POST /api/sessions/<id>/permissions/<key>` with `{ action: "close", by }` or `{ action: "push" }`. Answers the status, or `unreachable`. */
async function permissionAction(origin, token, sessionId, key, body, timeoutMs = HOOK_READ_TIMEOUT_MS) {
  if (!token) return "no-token";
  try {
    const res = await request(origin, `/api/sessions/${sessionId}/permissions/${key}`, { method: "POST", token, body, timeoutMs });
    return String(res.status);
  } catch {
    return "unreachable";
  }
}

/** Is process `pid` still there? A process of another user (EPERM) counts as there. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/** Take one request out of the state's map. Answers whether it was there. */
async function forgetRequest(file, harnessId, key) {
  return changeState(file, harnessId, (s) => {
    const had = Object.hasOwn(s.requests, key);
    delete s.requests[key];
    return had;
  }).catch(() => false);
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
  // D8: no message is handed on until the account check says the credentials agree.
  if (!ctx.active) return null;
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

/**
 * THE WAIT FOR THE OWNER'S ANSWER (the documented exception in the header),
 * driven by `askOwner` of `../bin/hook-core.mjs`: the SAME request post (its
 * retries, the close of a row that a lost answer may have made), the same
 * push (tried again on a status that a later try can fix), the same long
 * poll (its backoff, the close at the deadline, the post again after a long
 * gap that the server swept) as the Claude Code hook (/dcr wave 1 findings 9
 * and 61). This function gives it the bridge's own parts:
 *   - the bearer, read again for EVERY request (a worker may have refreshed
 *     it); no token, or a 401, asks a `refresh` worker (at most every 30 s)
 *     and counts as a failure that a later try can fix, as in the hook;
 *   - D8 as a sign (`account`), read at every pass: the credentials changed;
 *   - "I'm away" turned off as a sign read off an open answer (`away-off`,
 *     the `away` tier only, only an explicit `away: false`);
 *   - every sign closes the row as `gone`: the bridge never knows that the
 *     prompt was answered at the terminal (opencode's `permission.replied`
 *     closes that row itself, by its key);
 *   - an accepted row is a wait: `wait` is set (the next prompt's `working`
 *     closes a row that a killed hook left) and a detached `guard` worker
 *     closes it as `gone` if this process is killed. A row posted again
 *     moves to its new key in the map, with a guard of its own.
 * Answers the harness's `{ stdout, code }`: the owner's allow or deny (the
 * entry leaves the map BEFORE the print, so the echo of the shim's own reply
 * closes nothing), or `undefined` for the old path (a post that did not
 * land), or the harness's "no decision". Never refreshes a token.
 */
async function waitForOwner(ctx, file, sessionId, key, tier, body) {
  const { origin, harnessId, env } = ctx;
  const harness = harnessFor(harnessId);
  const start = Date.now();
  const none = hookExitFor(harnessId, harness.permissionEvent);
  let refreshAt = 0;
  const askRefresh = () => {
    if (Date.now() < refreshAt) return;
    spawnWorker("refresh", harnessId, file);
    refreshAt = Date.now() + 30_000;
  };
  const bearer = () => {
    const token = hookBearer(loadAuth(env, origin));
    if (!token) askRefresh();
    return token;
  };
  const call = async (method, route, payload, timeoutMs) => {
    const res = await sessionRequest(origin, bearer(), method, route, payload, timeoutMs);
    if (res.status === 401) askRefresh();
    return res;
  };
  const out = await askOwner(
    {
      now: Date.now,
      sleep,
      trace: (...words) => trace(env, harnessId, ctx.event, `perm ${words.join(" ")}`),
      request: (payload) => call("POST", `/api/sessions/${sessionId}/state`, payload, WORKER_REQUEST_TIMEOUT_MS),
      poll: (k, waitS) => call("GET", `/api/sessions/${sessionId}/permissions/${k}?wait=${waitS}`, undefined, waitS * 1000 + POLL_MARGIN_MS),
      action: async (k, payload) => (await call("POST", `/api/sessions/${sessionId}/permissions/${k}`, payload, WORKER_REQUEST_TIMEOUT_MS)).status,
      signs: () => (gateNow(env, origin).remote ? null : "account"),
      openSign: (answer) => (tier === "away" && answer.away === false ? "away-off" : null),
      closeBy: () => "gone",
      accepted: async (k) => {
        // The row is on the server. A guard closes it if this process is
        // killed, and the wait counts as posted, so the next prompt's
        // `working` closes every row that a killed hook left.
        await changeState(file, harnessId, (s) => {
          s.wait = "waiting_permission";
          s.pending = null;
        }).catch(() => {});
        spawnWorker("guard", harnessId, file, [k, String(process.pid)]);
      },
      rekey: (oldKey, newKey) =>
        changeState(file, harnessId, (s) => {
          const entry = s.requests[oldKey];
          delete s.requests[oldKey];
          if (entry) s.requests[newKey] = { ...entry, at: Date.now() };
        }).catch(() => {}),
      randomKey: () => crypto.randomUUID(),
    },
    { key, body, startedAt: start, deadline: start + permissionWaitFor(env, permissionWaitMs(harnessId)), pushAfterMs: pushAfterMsFor(env) },
  );
  if (out.kind === "decision" && harness.deliver === "shim") {
    // Out of the map BEFORE the print, so the echo of the plugin's own reply
    // closes nothing; the program's id of the prompt keeps the key in
    // `taken`, for a reply that opencode refuses (finding 29).
    await changeState(file, harnessId, (s) => {
      const ask = s.requests[out.key]?.ask ?? null;
      delete s.requests[out.key];
      if (ask) s.taken[ask] = { key: out.key, at: Date.now() };
    }).catch(() => {});
  } else {
    await forgetRequest(file, harnessId, out.key);
  }
  if (out.kind === "not-accepted") {
    trace(env, harnessId, ctx.event, `perm-post-${out.status} input=${body.inputTooLong ? "too-long" : body.toolInput ? "yes" : "no"}`);
    if (out.status === 404) {
      // The server no longer knows the session: register again.
      const ask = await changeState(file, harnessId, (s) => {
        s.sessionId = null;
        s.registerAt = 0;
        return claimRegistration(s);
      }).catch(() => false);
      if (ask) spawnWorker("register", harnessId, file);
    }
    // The server's brake (`accepted: false` in a 2xx): give up at once and
    // post nothing more (design 5.1). Any other refusal: the old path.
    const braked = out.status >= 200 && out.status < 300 && out.answer && typeof out.answer === "object" && out.answer.accepted === false;
    return braked ? none : undefined;
  }
  if (out.kind === "ended") {
    trace(env, harnessId, ctx.event, `decision-none ${out.why}`);
    return none;
  }
  const behavior = out.answer.state === "allowed" ? "allow" : "deny";
  trace(env, harnessId, ctx.event, `decision-${behavior} note=${out.answer.note ? "yes" : "no"}`);
  return permissionDecision(harnessId, behavior, behavior === "deny" ? denyMessage(typeof out.answer.note === "string" ? out.answer.note : null) : null) ?? none;
}

/**
 * A permission prompt that may wait for the owner's answer from PasserJack.
 * Answers `undefined` for the old path (the minute of silence, no answer
 * from PasserJack): a harness that never answers, the old shim call, no
 * remote answers for these credentials (D8), a tool name the server cannot
 * take, no session yet, the owner not away (`away` tier), or a request post
 * that did not land. Else the final `{ stdout, code }` (`waitForOwner`).
 */
async function remotePermission(ctx, harness, file, n, gate, cwd) {
  const { origin, harnessId, env } = ctx;
  const tier = permissionTier(harnessId);
  if (tier === "never" || (harness.deliver === "shim" && !n.answer)) return undefined;
  if (n.sandboxBypass) {
    // Copilot: an allow from a hook does not skip the prompt to leave the sandbox.
    trace(env, harnessId, n.event, "perm-sandbox");
    return undefined;
  }
  if (!gate.remote) {
    trace(env, harnessId, n.event, `perm-no-remote ${gate.needsCheck ? "unchecked" : "env-key"}`);
    return undefined;
  }
  // A tool name the server cannot take: the page could not say which tool
  // gets the input, so the bridge takes no part (/dcr wave 1 finding 68).
  if (!n.tool) {
    trace(env, harnessId, n.event, "perm-no-tool");
    return undefined;
  }
  const sessionId = readState(file, harnessId)?.sessionId;
  if (!sessionId || !ctx.token) {
    trace(env, harnessId, n.event, `perm-not-ready session=${sessionId ? "yes" : "no"} token=${ctx.token ? "yes" : "no"}`);
    return undefined;
  }
  const key = crypto.randomUUID();
  if (tier === "away") {
    // THE ONE READ: the session's "I'm away" switch, on the poll route with wait=0 (a key the server does not know yet).
    const read = await pollRequest(origin, ctx.token, sessionId, key, 0, HOOK_READ_TIMEOUT_MS);
    if (read.kind !== "answer" || read.away !== true) {
      trace(env, harnessId, n.event, `perm-away-off read=${read.kind}`);
      return undefined;
    }
    trace(env, harnessId, n.event, "perm-away-on");
  }
  if (harness.deliver === "shim") exitWithParent();
  await changeState(file, harnessId, (s) => {
    s.cwd ??= cwd;
    s.counter += 1;
    s.requests[key] = { ask: n.requestId, tool: n.tool, at: Date.now(), pid: process.pid };
  });
  // The one request that carries the input, from this process's memory.
  trace(env, harnessId, n.event, `perm-post input=${n.inputTooLong ? "too-long" : n.input ? "yes" : "no"}`);
  return waitForOwner(ctx, file, sessionId, key, tier, requestBody({ requestKey: key, tool: n.tool, input: n.input, inputTooLong: n.inputTooLong }));
}

/**
 * One hook event. Resolves to what stdout gets: a string (maybe nothing)
 * with the hook's "no decision" exit code (`hookExitFor`), or a permission
 * decision `{ stdout, code }`.
 */
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
    `normalized from=${String(eventArg).replace(/[^A-Za-z0-9_.-]/g, "?")} key=${n.sessionKey ? "yes" : "no"} cwd=${n.cwd ? "yes" : "no"} last=${n.lastMessage ? "yes" : "no"} tool=${n.tool ?? "none"} stopActive=${n.stopActive} input=${n.inputTooLong ? "too-long" : n.input ? "yes" : "no"} ask=${n.requestId ? "yes" : "no"}`,
  );
  const origin = resolveOrigin(env);
  if (!origin.ok) return silent;
  const auth = loadAuth(env, origin.origin);
  if (!auth) {
    trace(env, harnessId, n.event, "no-sign-in");
    return silent;
  }
  // D8: two credentials of different accounts: do nothing at all. No verdict
  // yet: no read and no answer here, and a worker asks.
  const gate = gateNow(env, origin.origin);
  if (gate.mismatch) {
    trace(env, harnessId, n.event, "account-mismatch");
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
  if (gate.needsCheck) {
    spawnWorker("check", harnessId, file);
    trace(env, harnessId, n.event, "account-unchecked");
  }
  const ctx = { origin: origin.origin, token, harnessId, env, event: n.event, active: gate.active };

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
    // A prompt was answered (opencode's `permission.replied`, with the
    // program's own id of it). A request that still waits for the owner
    // closes ONE row by its key: `terminal` for the person at the terminal,
    // `session` for a prompt that opencode itself rejected after the owner's
    // Deny on another one (/dcr wave 1 finding 38: until then the page said
    // "answered at the terminal" for a rejection the owner caused). `working`
    // closes every open row of the session, so it is posted only when no
    // request waits. A request that the waiter already took (the echo of the
    // plugin's own reply) is out of the map, and nothing closes twice.
    const out = await changeState(file, harnessId, (s) => {
      s.counter += 1;
      s.pending = null;
      const close = [];
      // The echo of the plugin's own reply: the answer was handed on.
      if (n.requestId) delete s.taken[n.requestId];
      if (n.requestId) {
        for (const [requestKey, r] of Object.entries(s.requests)) {
          if (r.ask !== n.requestId) continue;
          close.push(requestKey);
          delete s.requests[requestKey];
        }
      }
      const open = Object.keys(s.requests).length === 0 ? s.wait : null;
      if (open) s.wait = null;
      return { open, close };
    });
    const by = n.closer === "session" ? "session" : "terminal";
    for (const requestKey of out.close) spawnWorker("close", harnessId, file, [requestKey, by]);
    if (out.open) spawnWorker("working", harnessId, file);
    trace(env, harnessId, n.event, `${out.open ? "working" : "resolved"} closed-${out.close.length} by-${by}`);
    return silent;
  }

  if (n.event === "reply_refused") {
    // The shim took the owner's answer (the row closed as `owner`), and
    // opencode refused its out-of-band reply, or the reply threw (/dcr wave 1
    // finding 29): the prompt waits at the terminal, so the page must not say
    // "Allowed here". The row closes as `terminal` by the request's own
    // credential and key, which the server takes as a re-resolve of a taken row.
    const key = await changeState(file, harnessId, (s) => {
      const taken = n.requestId ? s.taken[n.requestId] : null;
      if (n.requestId) delete s.taken[n.requestId];
      return taken?.key ?? null;
    }).catch(() => null);
    if (key) spawnWorker("close", harnessId, file, [key, "terminal"]);
    trace(env, harnessId, n.event, `perm-reply-refused taken=${key ? "yes" : "no"}`);
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
    // The event whose output is the decision (Codex's PermissionRequest, the
    // opencode waiter), not a notification that a prompt is up.
    if (n.event === "permission" && eventArg === harness.permissionEvent) {
      const answered = await remotePermission(ctx, harness, file, n, gate, cwd);
      if (answered !== undefined) return answered;
      // Copilot's permissionRequest has no old path: its notification hook posts the prompt.
      if (harness.permissionLegacy === false) return silent;
    }
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

  // D8 first, in every worker: with two credentials of different accounts (or
  // no verdict yet that they agree), nothing registers, posts or refreshes.
  const gate = await checkedGate(env, origin.origin);
  if (!gate.active) {
    trace(env, harnessId, "worker", `${String(job).slice(0, 20)}-account-${gate.mismatch ? "mismatch" : "unchecked"}`);
    return;
  }
  if (job === "check") return;

  if (job === "refresh") {
    await workerToken(auth);
    return;
  }
  if (job === "close") {
    // One request row closes: `terminal` (`permission.replied`, or a reply
    // that opencode refused), `session` (opencode rejected it itself) or `gone`.
    const [key, by] = extra;
    if (!UUID_RE.test(key ?? "") || (by !== "terminal" && by !== "gone" && by !== "session")) return;
    const sessionId = readState(file, harnessId)?.sessionId;
    if (!sessionId) return;
    const out = await permissionAction(ctx.origin, await workerToken(auth), sessionId, key, { action: "close", by }, WORKER_REQUEST_TIMEOUT_MS);
    trace(env, harnessId, "worker", `close-${by}-${out}`);
    return;
  }
  if (job === "guard") {
    // The waiting process of one request: when it is gone with its request
    // still in the map (killed at the harness's timeout, or with its program),
    // the row closes as `gone`, so the page stops offering an answer that
    // nothing would take. Bounded by the longest wait.
    const [key, pidText] = extra;
    const pid = Number(pidText);
    if (!UUID_RE.test(key ?? "") || !Number.isSafeInteger(pid) || pid <= 1) return;
    const until = Date.now() + SHIM_PERMISSION_WAIT_MS + 60_000;
    while (Date.now() < until) {
      await sleep(GUARD_CHECK_MS);
      const entry = readState(file, harnessId)?.requests?.[key];
      if (!entry || entry.pid !== pid) return;
      if (alive(pid)) continue;
      if (!(await forgetRequest(file, harnessId, key))) return;
      const sessionId = readState(file, harnessId)?.sessionId;
      const out = sessionId
        ? await permissionAction(ctx.origin, await workerToken(auth), sessionId, key, { action: "close", by: "gone" }, WORKER_REQUEST_TIMEOUT_MS)
        : "no-session";
      trace(env, harnessId, "worker", `guard-closed-${out}`);
      return;
    }
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
      trace(env, harnessId, "worker", `wait-baseline ${baseline === null ? "none" : "taken"}`);
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
    // D8: two credentials of different accounts stop the watch with one line
    // (a Grok Build monitor shows its lines to the agent; the opencode
    // plugin's doorbell would read any line as a ring, so it gets none).
    const gate = await checkedGate(env, origin.origin);
    if (gate.mismatch) {
      if (harnessFor(harnessId).aliasByAncestor) print(ACCOUNTS_DIFFER_LINE);
      return;
    }
    if (!gate.active) {
      // No verdict yet (the server did not answer): ask again later, not at once.
      await sleep(backoffMs(attempt++));
      continue;
    }
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
  // The "no decision" answer comes from the arguments alone, BEFORE stdin is
  // read: every path that is not a decision ends with it (Junie's permission
  // hook exits 1, because an exit 0 approves).
  const fallback = hookExitFor(first, eventArg);
  let out = fallback;
  try {
    const answer = await runHook(first, eventArg, env);
    out = typeof answer === "string" ? { stdout: answer, code: fallback.code } : (answer ?? fallback);
  } catch (err) {
    // Silent on every failure: the harness goes on as if there were no hook.
    trace(env, String(first), String(eventArg), `hook-threw ${errorWord(err)}`);
  }
  finish(out.stdout, out.code);
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  // A throw that escaped `main` still ends with the hook's own "no decision" code.
  const fallback = hookExitFor(process.argv[2], process.argv[3]).code;
  main().catch(() => process.exit(fallback));
}
