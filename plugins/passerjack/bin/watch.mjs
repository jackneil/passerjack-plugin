#!/usr/bin/env node
/**
 * The PasserJack watcher: the plugin's monitor command.
 *
 * Claude Code starts this in the background for the whole of an interactive
 * session and turns every line it prints into a notification. It holds the
 * server-sent-events form of one feed per lane (`feed=items&tag=...`, and a
 * message lane that is `feed=messages&to=...` when a name is set and
 * `feed=messages&session=...` alone otherwise) and prints one line per doorbell,
 * message and catch-up, in the server's own lines-mode words.
 *
 * WHY THIS AND NOT THE CURL RECIPE. The server ends every feed at fourteen
 * minutes (Railway cuts any response at fifteen), and under the curl recipe
 * the command's exit is itself a wake-up: the session wakes, reads the goodbye,
 * and re-arms, four times an hour whether anything happened or not. This
 * process re-arms itself, carrying the goodbye's cursor as `Last-Event-ID`, so
 * the session only ever wakes for something that arrived.
 *
 * Configuration is environment only; see `readConfig`. The key goes into one
 * request header and nowhere else: never printed, never logged, never on a
 * command line.
 *
 * PRESENCE. At start it registers this session (`POST /api/sessions`: host,
 * the working directory's last segment, the repo's `owner/name`, the branch)
 * and prints ONE line saying so; before every reconnect it registers again,
 * silently and idempotently (same `clientId`), and each feed carries the
 * session id so the server can keep it marked present. A registration that
 * fails prints nothing and the watch runs on without presence. SIGINT, SIGTERM
 * and SIGHUP end the session (a DELETE bounded at two seconds) and exit: the
 * lanes never resolve on their own, so `beforeExit` would never fire, and the
 * signal handlers are the exit path.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import {
  BurstWindow,
  IDLE_TIMEOUT_MS,
  KEY_REFUSED_LINE,
  MAX_RETRY_HINT_MS,
  MIN_HEALTHY_LIFETIME_MS,
  NO_SESSION_LINE,
  OutageMemo,
  SseParser,
  TOO_MANY_WATCHERS_WAIT_MS,
  backoffMs,
  burstLineFor,
  feedUrl,
  laneStoppedLine,
  lineForFrame,
  readConfig,
  registeredLine,
  resumeHeader,
  sessionBody,
  sessionIdFrom,
} from "./watch-core.mjs";

const VERSION = "0.1.0";

function print(line) {
  process.stdout.write(`${line}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Statuses asking again will never fix: say so once and stop that lane. */
const PERMANENT = new Set([400, 403, 404]);

/** How long a registration may take before the watch goes on without it. */
const REGISTER_TIMEOUT_MS = 5000;

/** The whole budget for ending the session on the way out. */
const END_TIMEOUT_MS = 2000;

/**
 * A registration younger than this is not repeated before a connect. Both
 * lanes open together at start and reconnect within moments of each other
 * after the server's goodbye, and one POST answers for all of them.
 */
const FRESH_MS = 10_000;

function requestHeaders(config) {
  return {
    authorization: `Bearer ${config.key}`,
    "user-agent": `passerjack-claude-plugin/${VERSION}`,
  };
}

/**
 * One fact from git, or null on any failure (no git, not a repository, no
 * remote, a timeout). An argv array and no shell, so nothing in a directory
 * name or a remote is ever interpreted.
 */
function git(args) {
  return new Promise((resolve) => {
    execFile("git", args, { timeout: 2000, windowsHide: true, encoding: "utf8" }, (err, stdout) => {
      if (err) return resolve(null);
      const out = String(stdout ?? "").trim();
      resolve(out || null);
    });
  });
}

async function gatherFacts() {
  const [remote, branch] = await Promise.all([
    git(["remote", "get-url", "origin"]),
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  // Raw here and reduced by `sessionBody` before anything is sent: the full
  // directory and the remote URL (which may carry a token) never leave.
  return { hostname: os.hostname(), cwd: process.cwd(), remote, branch, clientId: randomUUID() };
}

/**
 * This session's registration. Quiet by construction: the only line it ever
 * prints is a successful registration's, once per distinct session id (the
 * first, and again only when the server hands back a NEW id because an End, an
 * eviction or the sweep took the old row), never on a same-id re-registration.
 */
class Presence {
  constructor(config, body) {
    this.config = config;
    this.body = body;
    this.id = null;
    this.confirmedAt = 0;
    this.inFlight = null;
    this.disabled = false;
    this.announcedId = null;
    /**
     * How the last registration went: `ok`, `unreachable` (no answer, or a
     * 5xx), `refused-401` (a dead key) or `refused-other` (any other refusal,
     * a 429 included). The nameless message lane reads it, because for that
     * lane a registration that failed is the whole watch failing.
     */
    this.lastOutcome = "ok";
  }

  /** One POST, shared by every caller while it is in flight. Resolves to its outcome. */
  register() {
    if (this.disabled) return Promise.resolve(this.lastOutcome);
    this.inFlight ??= this.post()
      .then((outcome) => {
        this.lastOutcome = outcome;
        return outcome;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Answers `ok`, `unreachable`, `refused-401` or `refused-other`; see `lastOutcome`. */
  async post() {
    let res;
    try {
      res = await fetch(new URL("/api/sessions", this.config.origin), {
        method: "POST",
        headers: { ...requestHeaders(this.config), "content-type": "application/json" },
        body: JSON.stringify(this.body),
        redirect: "error",
        signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
      });
    } catch {
      // Unreachable. Keep whatever id we had: the row outlives a blip, and the
      // feed that fails alongside will ask again on its next attempt.
      return "unreachable";
    }
    let answer = null;
    try {
      answer = await res.json();
    } catch {
      // Not JSON (a captive portal, a proxy page): no id.
    }
    if (this.disabled) return "refused-other";
    // A 5xx or a 429 is a transient, exactly like the network error above: the
    // server is overloaded or restarting, not saying no, so keep whatever id we
    // had. Only a real refusal (401 a dead key, 400 a shape, 409 the cap or a
    // foreign clientId) means no session, and the feed goes without one.
    if (res.status >= 500) return "unreachable";
    if (res.status === 429) return "refused-other";
    const id = res.ok ? sessionIdFrom(answer) : null;
    this.id = id;
    this.confirmedAt = id ? Date.now() : 0;
    if (id && id !== this.announcedId) {
      this.announcedId = id;
      print(registeredLine({ ...this.body, id }));
    }
    if (id) return "ok";
    return res.status === 401 ? "refused-401" : "refused-other";
  }

  /** The session id a connect should carry, registering again first unless that just happened. */
  async beforeConnect() {
    if (this.disabled) return null;
    if (Date.now() - this.confirmedAt >= FRESH_MS) await this.register();
    return this.disabled ? null : this.id;
  }

  /**
   * The feed answered 400 to a connect carrying `id`. Most likely the row went
   * (the owner ended it, or it was swept), so forget the id and its
   * confirmation and the next connect registers again; if that registration
   * then fails, the connect goes without a session rather than carrying the
   * dead id back into the same 400. If the registration was fresh and the feed
   * still refused it, presence is not going to work here: stop using it, so
   * the lane asks without a session and a 400 that is really about something
   * else still reaches the person with the server's own sentence.
   */
  refused(id) {
    if (this.disabled || id !== this.id) return;
    if (Date.now() - this.confirmedAt < FRESH_MS) {
      this.disabled = true;
      this.id = null;
    } else {
      this.id = null;
      this.confirmedAt = 0;
    }
  }

  /** End the session on the way out. Never throws, never takes longer than its budget. */
  async end() {
    const id = this.id;
    this.disabled = true;
    this.id = null;
    if (!id) return;
    try {
      await fetch(new URL(`/api/sessions/${id}`, this.config.origin), {
        method: "DELETE",
        headers: requestHeaders(this.config),
        redirect: "error",
        signal: AbortSignal.timeout(END_TIMEOUT_MS),
      });
    } catch {
      // Out of time or unreachable: the row stops being listed on its own once
      // its feed is gone.
    }
  }
}

/**
 * One connection, start to end. Answers how it ended:
 * `{ kind: "clean", healthy, retryHint }` for a stream that ended on its own,
 * `{ kind: "failed", healthy }` for anything transient, `{ kind: "busy" }` for a 429,
 * `{ kind: "stopped", status, body }` for a permanent refusal and
 * `{ kind: "unauthorized" }` for a 401.
 *
 * `onOpen` fires once the server has answered with a stream, which is what
 * counts as "back online".
 */
async function connect(config, lane, state, onOpen, sessionId) {
  const controller = new AbortController();
  let idle = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  };
  const started = Date.now();
  let openedAt = null;
  try {
    const headers = { accept: "text/event-stream", ...requestHeaders(config) };
    const cursor = resumeHeader(state.lastEventId);
    if (cursor !== null) headers["last-event-id"] = cursor;
    // `redirect: "error"`: a redirect is never followed with a bearer key on it.
    const res = await fetch(feedUrl(config.origin, lane, sessionId), {
      headers,
      signal: controller.signal,
      redirect: "error",
    });
    if (res.status === 401) return { kind: "unauthorized" };
    if (res.status === 429) return { kind: "busy" };
    if (PERMANENT.has(res.status)) {
      return { kind: "stopped", status: res.status, body: await res.text().catch(() => "") };
    }
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !res.body || !type.startsWith("text/event-stream")) {
      // A 5xx, or a captive portal answering 200 with a web page.
      await res.body?.cancel().catch(() => {});
      return { kind: "failed" };
    }
    openedAt = Date.now();
    onOpen();
    const parser = new SseParser(state.lastEventId);
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let sawFrame = false;
    let retryHint = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      touch();
      for (const record of parser.push(decoder.decode(value, { stream: true }))) {
        if (record.type === "retry") {
          // The opening hint is the server's reconnect spread for a browser;
          // only one arriving after the first frame is a drain saying "wait".
          if (sawFrame) retryHint = Math.min(record.ms, MAX_RETRY_HINT_MS);
          continue;
        }
        sawFrame = true;
        const out = lineForFrame(lane, record);
        if (!out) continue;
        if (out.kind === "catchup") print(out.line);
        else state.burst.ring(out.line);
      }
      // Kept after every chunk rather than at the end, so a connection that
      // dies mid-stream still resumes from the last cursor it heard.
      state.lastEventId = parser.lastEventId;
    }
    const healthy = sawFrame && Date.now() - started >= MIN_HEALTHY_LIFETIME_MS;
    return { kind: "clean", healthy, retryHint };
  } catch {
    // A network error, a refused redirect, or the idle watchdog. Transient by
    // definition, and deliberately unprinted: see `OutageMemo`. `healthy` says
    // the stream had been up long enough that this is a fresh blip rather than
    // more of an earlier outage, so the backoff starts over.
    const healthy = openedAt !== null && Date.now() - openedAt >= MIN_HEALTHY_LIFETIME_MS;
    return { kind: "failed", healthy };
  } finally {
    clearTimeout(idle);
  }
}

/** Whether this process already said `NO_SESSION_LINE`: once, ever. */
let noSessionSaid = false;

/** Exit once the key-refused line is written; see the 401 branch in `runLane`. */
function stopOnDeadKey() {
  // Exit once the line is written: stdout is asynchronous on some pipes, and
  // an exit ahead of the write would stop in silence.
  process.stdout.write(`${KEY_REFUSED_LINE}\n`, () => process.exit(0));
  return new Promise(() => {});
}

/**
 * One lane's reconnect loop. Resolves when the lane stops for good. `onlyLane`
 * says no other lane is running, which matters to the nameless message lane:
 * alone, nothing else would ever report a dead key or an outage for it.
 */
async function runLane(config, lane, outage, presence, onlyLane) {
  const state = {
    lastEventId: "",
    burst: new BurstWindow(print, (n) => burstLineFor(lane, n), (fn, ms) => setTimeout(fn, ms).unref()),
  };
  let attempt = 0;
  for (;;) {
    const sessionId = await presence.beforeConnect();
    if (lane.kind === "messages" && lane.to === null && !sessionId) {
      // A nameless message lane IS its session (the server rings it for what
      // hinted sends deliver there), so without one it has nothing to ask for
      // and the server would refuse it. What the registration said decides
      // what, if anything, is printed; then wait and try again.
      const outcome = presence.lastOutcome;
      if (outcome === "refused-401" && onlyLane) return stopOnDeadKey();
      if (outcome === "unreachable") {
        // The one lane that would otherwise sit silent through an outage:
        // feed the same memo a failed connect does, so the offline line can print.
        const line = outage.failed(lane, Date.now());
        if (line) print(line);
        await sleep(backoffMs(attempt));
        attempt += 1;
        continue;
      }
      outage.answered(lane);
      // A dead key with other lanes running: they say it, and exit.
      if (!noSessionSaid && outcome !== "refused-401") {
        noSessionSaid = true;
        print(NO_SESSION_LINE);
      }
      await sleep(TOO_MANY_WATCHERS_WAIT_MS);
      continue;
    }
    if (lane.kind === "messages" && lane.to === null) {
      // Registered again after an outage on this lane: say so if it was said.
      const back = outage.recovered(lane);
      if (back) print(back);
    }
    const ended = await connect(
      config,
      lane,
      state,
      () => {
        const line = outage.recovered(lane);
        if (line) print(line);
      },
      sessionId,
    );
    if (ended.kind === "stopped" && ended.status === 400 && sessionId) {
      // Possibly the session the feed was asked to carry, not the watch
      // itself: never a reason to stop the lane. See `Presence.refused`.
      outage.answered(lane);
      presence.refused(sessionId);
      // Backed off like any other retry, so a refusal that repeats cannot spin
      // the loop against the server.
      await sleep(backoffMs(attempt));
      attempt += 1;
      continue;
    }
    if (ended.kind === "unauthorized") return stopOnDeadKey();
    if (ended.kind === "stopped") {
      // The server answered, so this lane is not offline, and it will never
      // fail or recover again: take it out of the outage memo, or its old
      // failure time would fake an offline line on the other lane's next blip
      // and hold "back online" back for good.
      const back = outage.recovered(lane);
      if (back) print(back);
      print(laneStoppedLine(ended.status, ended.body));
      return;
    }
    if (ended.kind === "clean" && ended.healthy) {
      // The goodbye, or a drain: straight back, from the cursor it left.
      attempt = 0;
      if (ended.retryHint) await sleep(ended.retryHint);
      continue;
    }
    if (ended.kind === "busy") {
      // Too many feeds open on the account. The server answered, so this is
      // not an outage: wait silently and never feed the offline line.
      outage.answered(lane);
      attempt = 0;
      await sleep(TOO_MANY_WATCHERS_WAIT_MS);
      continue;
    }
    if (ended.healthy) attempt = 0;
    const line = outage.failed(lane, Date.now());
    if (line) print(line);
    await sleep(backoffMs(attempt));
    attempt += 1;
  }
}

async function main() {
  const config = readConfig(process.env);
  if (!config.ok) {
    print(config.line);
    return;
  }
  const presence = new Presence(config, sessionBody(process.env, await gatherFacts()));
  let ending = false;
  const stop = () => {
    // A second signal while the first is still ending the session: go now.
    if (ending) process.exit(0);
    ending = true;
    presence.end().finally(() => process.exit(0));
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, stop);

  await presence.register();
  const outage = new OutageMemo();
  const onlyLane = config.lanes.length === 1;
  await Promise.all(config.lanes.map((lane) => runLane(config, lane, outage, presence, onlyLane)));
  // Every lane stopped for good: nothing is watching, so nothing is present.
  await presence.end();
}

main().catch((err) => {
  // Only a bug reaches here. Its class and nothing more: a message is free
  // text, and this line lands in the session's context.
  print(`[passerjack] watch stopped: unexpected ${err instanceof Error ? err.name : "error"}`);
});
