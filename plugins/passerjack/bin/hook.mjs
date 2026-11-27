#!/usr/bin/env node
/**
 * The plugin's hook command: `node hook.mjs stop|permission|idle|tool|prompt|start|request`,
 * run by Claude Code (`hooks/hooks.json`; `tool` for both PostToolUse and
 * PostToolUseFailure) with the hook's JSON on stdin: every
 * event as an ASYNC hook, except `request` (PermissionRequest), the one
 * SYNCHRONOUS hook, which may print a decision. The decisions are
 * `hook-core.mjs`; this file gives them the real clock, the real transcript,
 * the hooks' state file, the process table and the network.
 *
 * WHERE IT POSTS: `POST /api/sessions/<id>/state` on the origin the watcher
 * registered with, for the session the watcher holds (`session-link.mjs`).
 * The text it sends (the turn's last message, unless
 * `PASSERJACK_SHARE_LAST_MESSAGE=0`) goes to the owner's own PasserJack
 * account and is shown on the Agents page. It never pushes a phone. The
 * request hook also sends the tool's input (the one place it goes, design
 * `docs/plans/2026-11-26-remote-permission/design.html`, D1), long-polls
 * `GET /api/sessions/<id>/permissions/<requestKey>?wait=25`, and posts
 * `POST /api/sessions/<id>/permissions/<requestKey>` with `close` or `push`.
 * Every request reads the bearer again: the watcher's renewal ends the old
 * access token at once.
 *
 * THE CREDENTIAL is the watcher's: `PASSERJACK_API_KEY` when it is set, else
 * the file `/passerjack:connect` writes. A hook NEVER refreshes a sign-in: it
 * is a short process, and a refresh whose new pair it could not save would
 * spend the refresh token for nothing (the next refresh would read as a
 * replay and end the connection). It uses the access token the watcher keeps
 * fresh, and a token that has run out means this one post is skipped.
 *
 * SILENT AND EXIT 0, ALWAYS: nothing is printed, whatever happens, except
 * the request hook's one decision, written as ONE JSON line, and the process
 * exits only in that write's callback (an exit before a pipe write finished
 * could drop it). With `PASSERJACK_HOOK_DEBUG=1` a closed-word trace
 * (`trace.mjs`) says which step gave up: `no-link`, `no-token`, `no-remote`,
 * `post-<status>`, `request <status>`, `poll <status>`, `link-gone`,
 * `close-<by> <status>`, `push <status>`, `decided-allow`, `decided-deny`,
 * `<event>-threw <class>` (a throw inside the event), `hook-threw <class>`
 * (a throw outside it); the request hook's full list is in
 * `.claude/rules/claude-code-plugin.md`. Never a key, an input, a command
 * line, a note or a rule.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { authIdentity, hookBearer, loadAuth, remoteMark } from "./credentials.mjs";
import { POLL_MARGIN_MS, POLL_TIMEOUT_MS, POLL_WAIT_S, POST_TIMEOUT_MS, runHook, SIGN_TICK_MS, TRANSCRIPT_TAIL_BYTES } from "./hook-core.mjs";
import { childCommandsOf, childrenOf } from "./programs.mjs";
import { claudeKey, linksDir, processAlive, readHookState, readLink, updateHookState } from "./session-link.mjs";
import { notClaudeCode } from "./hook-core.mjs";
import { trace as traceTo, TRACE_SWITCHES } from "./trace.mjs";
import { originAllowed } from "./watch-core.mjs";

const VERSION = "0.4.0";

/** The events `hooks/hooks.json` runs this file for. */
const EVENTS = new Set(["stop", "permission", "idle", "tool", "prompt", "start", "request"]);
/** The most stdin read: a turn's last message can be long, and the rest is cut. */
const MAX_STDIN_BYTES = 8 * 1024 * 1024;

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    process.stdin.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= MAX_STDIN_BYTES) chunks.push(chunk);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

function size(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

function tail(file) {
  try {
    const handle = fs.openSync(file, "r");
    try {
      const { size: total } = fs.fstatSync(handle);
      const length = Math.min(total, TRANSCRIPT_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, total - length);
      const text = buffer.toString("utf8");
      // The first line is a part of a line unless the read started at 0.
      return length < total ? text.slice(text.indexOf("\n") + 1) : text;
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return "";
  }
}

/** The event this process runs for, in every trace line. */
const EVENT = process.argv[2];

/** One trace line (`PASSERJACK_HOOK_DEBUG=1` only): the event, then closed words. */
function trace(...words) {
  traceTo(process.env, TRACE_SWITCHES.hook, path.join(linksDir(), "hook-debug.log"), "hook", EVENT, ...words);
}

async function post(link, body) {
  let url;
  try {
    url = new URL(`/api/sessions/${link.sessionId}/state`, link.origin);
  } catch {
    trace("bad-origin");
    return false;
  }
  if (!originAllowed(url)) {
    trace("bad-origin");
    return false;
  }
  // The environment's key, else a saved sign-in that has not run out. Never a refresh.
  const token = hookBearer(loadAuth(process.env, url.origin));
  if (!token) {
    trace("no-token");
    return false;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": `passerjack-claude-plugin/${VERSION} hook`,
      },
      body: JSON.stringify(body),
      // A redirect is never followed with a bearer on it.
      redirect: "error",
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
    trace(`post-${body.state}`, res.status);
    return res.ok;
  } catch (err) {
    trace(`post-${body.state}`, "unreachable", err instanceof Error ? err.name : "error");
    return false;
  }
}

/** The ms of a `retry-after` header in seconds, or null. */
function retryAfterMs(res) {
  const seconds = Number(res.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/**
 * One request of the request hook to its session, with the bearer read again
 * now. Answers `{ status, answer, retryAfterMs }`: `status` 0 for no answer
 * (no token, an origin that is not allowed, the network, the timeout),
 * `answer` the JSON body or null. `signal` ends it early (a terminal sign).
 */
async function sessionCall(link, method, pathname, { body = undefined, timeoutMs = POST_TIMEOUT_MS, signal = undefined } = {}) {
  let url;
  try {
    url = new URL(pathname, link.origin);
  } catch {
    return { status: 0, answer: null, retryAfterMs: null };
  }
  if (!originAllowed(url)) return { status: 0, answer: null, retryAfterMs: null };
  const token = hookBearer(loadAuth(process.env, url.origin));
  if (!token) return { status: 0, answer: null, retryAfterMs: null };
  // One controller for the timeout and the caller's signal (Node 18 has no AbortSignal.any).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "user-agent": `passerjack-claude-plugin/${VERSION} hook`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: controller.signal,
    });
    let answer = null;
    if ((res.headers.get("content-type") ?? "").includes("application/json")) {
      try {
        answer = await res.json();
      } catch {
        answer = null;
      }
    } else {
      await res.body?.cancel().catch(() => {});
    }
    return { status: res.status, answer, retryAfterMs: retryAfterMs(res) };
  } catch {
    return { status: 0, answer: null, retryAfterMs: null };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * D8: may this hook's bearer get the owner's answers? Only when the link
 * carries the remote-answer mark of THIS bearer: the watcher writes it for
 * the saved sign-in, or for an environment key that it proved to be of the
 * saved sign-in's account, and for nothing else.
 */
function remoteAllowed(link) {
  let origin;
  try {
    origin = new URL(link.origin);
  } catch {
    trace("bad-origin");
    return false;
  }
  if (!originAllowed(origin)) {
    trace("bad-origin");
    return false;
  }
  const auth = loadAuth(process.env, origin.origin);
  if (!hookBearer(auth)) {
    trace("no-token");
    return false;
  }
  if (!link.remote || remoteMark(authIdentity(auth)) !== link.remote) {
    trace("no-remote");
    return false;
  }
  return true;
}

/**
 * The long poll, with the terminal signs read every `SIGN_TICK_MS` while it
 * is open: a sign ends the request at once and answers `{ sign }`. `probe`
 * is the slow sign (the shell of this call, a `ps` read): one at a time,
 * started at a tick when none is in flight. The poll's own bound is its hold
 * and `POLL_MARGIN_MS`, so a poll never runs past the hook's deadline.
 */
async function poll(link, key, signs, waitS = POLL_WAIT_S, probe = null) {
  const controller = new AbortController();
  let sign = null;
  let probing = false;
  const timer = setInterval(() => {
    try {
      sign ??= signs() || null;
    } catch {
      sign = null;
    }
    if (!sign && probe && !probing) {
      probing = true;
      probe()
        .then(
          (found) => {
            if (found && !sign) {
              sign = found;
              controller.abort();
            }
          },
          () => {},
        )
        .finally(() => {
          probing = false;
        });
    }
    if (sign) controller.abort();
  }, SIGN_TICK_MS);
  try {
    const res = await sessionCall(link, "GET", `/api/sessions/${link.sessionId}/permissions/${key}?wait=${waitS}`, {
      timeoutMs: Math.min(POLL_TIMEOUT_MS, waitS * 1000 + POLL_MARGIN_MS),
      signal: controller.signal,
    });
    return sign ? { sign } : res;
  } finally {
    clearInterval(timer);
  }
}

async function main() {
  const event = process.argv[2];
  if (!EVENTS.has(event)) return null;
  if (notClaudeCode(process.env, null)) return null;
  const dir = linksDir();
  const key = claudeKey(process.env);
  // PostToolUse (and PostToolUseFailure, the same `tool` event) runs for
  // EVERY tool call of every session, and its payload
  // carries the tool's whole answer (a file read can be megabytes). Almost
  // every one finds no permission mark, so it leaves before it reads or
  // parses its stdin (/dcr wave 2). `runHook` reads the mark again under its
  // lock when there is one.
  if (event === "tool") {
    const seen = readHookState(dir, key);
    if (!seen?.pending && !seen?.requests.length) return null;
  }
  let input = {};
  try {
    const parsed = JSON.parse(await readStdin());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
  } catch {
    return null;
  }
  if (notClaudeCode(process.env, input)) return null;
  const out = await runHook(event, input, {
    env: process.env,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    size,
    tail,
    link: () => {
      const link = readLink(dir, key, processAlive);
      if (!link) trace(key ? "no-link" : "no-claude-pid");
      return link;
    },
    post,
    state: () => readHookState(dir, key),
    update: (fn) => updateHookState(dir, key, fn),
    // The children of this Claude Code process, other than this hook's own line.
    children: () => (key ? childrenOf(Number(key)) : Promise.resolve(null)),
    // The same children with their command lines, for the request hook's
    // compare only (`shellCallRuns`): never traced, posted or stored.
    childCommands: () => (key ? childCommandsOf(Number(key)) : Promise.resolve(null)),
    // The call digest of a request entry (`callText`): a sha256, never the input.
    digest: (text) => createHash("sha256").update(text).digest("hex"),
    // Whether this Claude Code process still runs: a permission waiter whose
    // session closed in its minute pushes nothing.
    claudeAlive: () => (key ? processAlive(Number(key)) : true),
    // The request hook's own (`runRequest` in hook-core.mjs).
    pid: process.pid,
    alive: processAlive,
    randomKey: randomUUID,
    remote: remoteAllowed,
    request: (link, body) => sessionCall(link, "POST", `/api/sessions/${link.sessionId}/state`, { body }),
    poll,
    action: async (link, requestKey, body) =>
      (await sessionCall(link, "POST", `/api/sessions/${link.sessionId}/permissions/${requestKey}`, { body })).status,
    trace,
  });
  // Only the request hook prints, and only a decision object.
  return event === "request" && out && typeof out === "object" ? out : null;
}

main().then(
  (decision) => {
    // ONE line, and the exit only once it is written: on a pipe, an exit
    // ahead of the write could drop the decision.
    if (decision) process.stdout.write(`${JSON.stringify(decision)}\n`, () => process.exit(0));
    else process.exit(0);
  },
  (err) => {
    trace("hook-threw", err instanceof Error ? err.name : "error");
    process.exit(0);
  },
);
