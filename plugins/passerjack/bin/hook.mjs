#!/usr/bin/env node
/**
 * The plugin's hook command: `node hook.mjs stop|permission|idle|tool|prompt|start`,
 * run by Claude Code as an ASYNC hook (`hooks/hooks.json`), with the hook's
 * JSON on stdin. The decisions are `hook-core.mjs`; this file gives them the
 * real clock, the real transcript, the hooks' state file, the process table
 * and the network.
 *
 * WHERE IT POSTS: `POST /api/sessions/<id>/state` on the origin the watcher
 * registered with, for the session the watcher holds (`session-link.mjs`).
 * The text it sends (the turn's last message, unless
 * `PASSERJACK_SHARE_LAST_MESSAGE=0`) goes to the owner's own PasserJack
 * account and is shown on the Agents page. It never pushes a phone.
 *
 * THE CREDENTIAL is the watcher's: `PASSERJACK_API_KEY` when it is set, else
 * the file `/passerjack:connect` writes. A hook NEVER refreshes a sign-in: it
 * is a short process, and a refresh whose new pair it could not save would
 * spend the refresh token for nothing (the next refresh would read as a
 * replay and end the connection). It uses the access token the watcher keeps
 * fresh, and a token that has run out means this one post is skipped.
 *
 * SILENT AND EXIT 0, ALWAYS: nothing is printed, whatever happens. With
 * `PASSERJACK_HOOK_DEBUG=1` a closed-word trace (`trace.mjs`) says which step
 * gave up: `no-link`, `no-token`, `post-<status>`, `hook-threw <class>`.
 */

import fs from "node:fs";
import path from "node:path";
import { hookBearer, loadAuth } from "./credentials.mjs";
import { POST_TIMEOUT_MS, runHook, TRANSCRIPT_TAIL_BYTES } from "./hook-core.mjs";
import { childrenOf } from "./programs.mjs";
import { claudeKey, linksDir, processAlive, readHookState, readLink, updateHookState } from "./session-link.mjs";
import { notClaudeCode } from "./hook-core.mjs";
import { trace as traceTo, TRACE_SWITCHES } from "./trace.mjs";
import { originAllowed } from "./watch-core.mjs";

const VERSION = "0.3.0";

/** The events `hooks/hooks.json` runs this file for. */
const EVENTS = new Set(["stop", "permission", "idle", "tool", "prompt", "start"]);
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

async function main() {
  const event = process.argv[2];
  if (!EVENTS.has(event)) return;
  if (notClaudeCode(process.env, null)) return;
  const dir = linksDir();
  const key = claudeKey(process.env);
  // PostToolUse runs for EVERY tool call of every session, and its payload
  // carries the tool's whole answer (a file read can be megabytes). Almost
  // every one finds no permission mark, so it leaves before it reads or
  // parses its stdin (/dcr wave 2). `runHook` reads the mark again under its
  // lock when there is one.
  if (event === "tool" && !readHookState(dir, key)?.pending) return;
  let input = {};
  try {
    const parsed = JSON.parse(await readStdin());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
  } catch {
    return;
  }
  if (notClaudeCode(process.env, input)) return;
  await runHook(event, input, {
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
    // Whether this Claude Code process still runs: a permission waiter whose
    // session closed in its minute pushes nothing.
    claudeAlive: () => (key ? processAlive(Number(key)) : true),
  });
}

main()
  .catch((err) => trace("hook-threw", err instanceof Error ? err.name : "error"))
  .finally(() => process.exit(0));
