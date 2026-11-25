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
 * THE CREDENTIAL. `PASSERJACK_API_KEY` from the environment wins when it is
 * set (see `readConfig`). Otherwise the credentials file that
 * `/passerjack:connect` writes (`credentials.mjs`): a browser sign-in, whose
 * access token this process refreshes before it expires and on a 401, under a
 * lock shared by every session on the machine, or a key saved with `--paste`.
 * With neither, it prints ONE waiting line and checks the file every three
 * seconds, so a sign-in made after Claude Code started reaches this session
 * with no restart. A sign-in the server refuses prints ONE stopped line and
 * the watch waits again. WHILE it watches it keeps checking the file the same
 * way: a sign-out stops the watch with no line (the person did it on
 * purpose), and a new sign-in (another account, or a pasted key) restarts the
 * watch on it. The key or token goes into one request header and nowhere
 * else: never printed, never logged, never on a command line.
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
import fs from "node:fs";
import os from "node:os";
import {
  bearerOf,
  credentialsPath,
  fingerprint,
  needsRefresh,
  readCredentials,
  renewCredential,
  requestRefresh,
  sameSignIn,
} from "./credentials.mjs";
import { findOnPath, safeCwd } from "./programs.mjs";
import {
  BurstWindow,
  IDLE_TIMEOUT_MS,
  KEY_REFUSED_LINE,
  MAX_RETRY_HINT_MS,
  MIN_HEALTHY_LIFETIME_MS,
  NO_SESSION_LINE,
  OutageMemo,
  SAVED_KEY_REFUSED_LINE,
  SIGN_IN_EXPIRED_LINE,
  SseParser,
  TOO_MANY_WATCHERS_WAIT_MS,
  WAITING_FOR_SIGN_IN_LINE,
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

const VERSION = "0.2.1";

function print(line) {
  process.stdout.write(`${line}\n`);
}

/** A sleep that ends early when `signal` aborts (the credential died). */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** How often the waiting watcher looks at the credentials file: one `stat`. */
const SIGN_IN_POLL_MS = 3000;

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

function requestHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    "user-agent": `passerjack-claude-plugin/${VERSION}`,
  };
}

/**
 * A key from `PASSERJACK_API_KEY`. It cannot be renewed, and a 401 on it keeps
 * the behaviour it always had: say so once and exit (`stopOnDeadKey`).
 */
class EnvAuth {
  constructor(key) {
    this.key = key;
    this.kind = "env";
    this.dead = false;
    this.stopReason = null;
    this.signal = new AbortController().signal;
    this.inFlight = null;
  }

  get stopped() {
    return false;
  }

  async bearer() {
    return this.key;
  }

  token() {
    return this.key;
  }

  async recover() {
    return "dead";
  }

  stop() {}
}

/**
 * A credential from the credentials file. ONE recovery runs at a time in this
 * process (every lane and the registration can hit the same 401 together),
 * and `refreshUnderLock` makes it one per MACHINE: it re-reads the file under
 * the lock, so a token another session already refreshed is used rather than
 * spending the refresh token a second time, which the server would read as a
 * replay outside its grace window.
 *
 * The watch on this credential STOPS (`signal` aborts, every lane drops what
 * it is doing) for one of three reasons, in `stopReason`:
 *   - `refused`: the server refused the credential. `main` prints one line
 *     and waits for a different one.
 *   - `signed-out`: the file is gone, or now names another origin. A person
 *     did that on purpose, so nothing is printed, and the watch waits.
 *   - `replaced`: the file holds a NEW sign-in (another `connection` id, or
 *     another key). The watch starts again on it, with a new presence
 *     `clientId`, because it may be another account.
 * A token that another session rotated is the SAME sign-in (`sameSignIn`),
 * and is taken over in place with no stop.
 */
class FileAuth {
  constructor(file, cred) {
    this.file = file;
    this.cred = cred;
    this.kind = cred.kind;
    this.dead = false;
    this.stopReason = null;
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.inFlight = null;
    /** A rotated pair that the file could not take: see `refreshUnderLock`. */
    this.unsaved = null;
    this.fileTimer = null;
    this.fileStamp = statStamp(file);
  }

  get stopped() {
    return this.stopReason !== null;
  }

  token() {
    return bearerOf(this.cred);
  }

  /** The token to send, refreshed first when it has less than a few minutes left. */
  async bearer() {
    if (!this.stopped && needsRefresh(this.cred)) await this.recover(this.token());
    return this.token();
  }

  /**
   * `usedToken` was refused (or is due). Answers `ok` (use `token()` now),
   * `transient` (try again later; the network or the lock) or `dead`.
   */
  recover(usedToken) {
    if (this.stopped) return Promise.resolve("dead");
    if (this.token() !== usedToken) return Promise.resolve("ok");
    this.inFlight ??= this.renew(usedToken).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async renew(usedToken) {
    const out = await renewCredential(this.file, {
      staleToken: usedToken,
      refresh: (cred) => requestRefresh(cred),
      unsaved: this.unsaved,
    });
    if (this.stopped) return "dead";
    if (out.kind === "transient") return "transient";
    if (out.kind === "ok") {
      if (!sameSignIn(this.cred, out.cred)) {
        this.stop("replaced");
        return "dead";
      }
      // `replaces` is what the FILE holds, which after two failed saves is
      // older than the pair this process held before.
      this.unsaved = out.saved === false ? { cred: out.cred, replaces: out.replaces } : null;
      this.cred = out.cred;
      this.fileStamp = statStamp(this.file);
      return "ok";
    }
    if (out.kind === "gone") {
      this.stop("signed-out");
      return "dead";
    }
    this.dead = true;
    this.stop("refused");
    return "dead";
  }

  stop(reason) {
    if (this.stopReason !== null) return;
    this.stopReason = reason;
    this.unwatchFile();
    this.controller.abort();
  }

  /**
   * While the watch runs, one `stat` of the file every few seconds, the same
   * check `waitForSignIn` makes. Nothing else would ever see a sign-out or a
   * new sign-in: a pasted key never comes due, and a browser sign-in only
   * looks at the file when it refreshes, up to an hour later.
   */
  watchFile(origin) {
    this.fileTimer = setInterval(() => {
      const stamp = statStamp(this.file);
      if (stamp === this.fileStamp) return;
      this.fileStamp = stamp;
      const cred = stamp === "missing" ? null : readCredentials(this.file);
      if (!cred || cred.origin !== origin) {
        this.stop("signed-out");
      } else if (!sameSignIn(this.cred, cred)) {
        this.stop("replaced");
      } else if (fingerprint(cred) !== fingerprint(this.cred) && !this.unsaved) {
        // Another session rotated the pair: take it over in place.
        this.cred = cred;
      }
    }, SIGN_IN_POLL_MS);
    this.fileTimer.unref?.();
  }

  unwatchFile() {
    if (this.fileTimer) clearInterval(this.fileTimer);
    this.fileTimer = null;
  }
}

/** One `stat` of the file, as a stamp that changes when the file does. */
function statStamp(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

/**
 * One fact from git, or null on any failure (no git, not a repository, no
 * remote, a timeout). An argv array and no shell, so nothing in a directory
 * name or a remote is ever interpreted.
 *
 * `git` is started by its ABSOLUTE path from an absolute PATH entry, never by
 * a bare name: on Windows a bare name is looked for in the current folder
 * first, which is the project, so a `git.exe` in a cloned repository would
 * run (`programs.mjs`). The project is named with `-C`, and on Windows the
 * child starts in System32.
 */
function git(gitPath, args) {
  return new Promise((resolve) => {
    if (!gitPath) return resolve(null);
    execFile(
      gitPath,
      ["-C", process.cwd(), ...args],
      { timeout: 2000, windowsHide: true, encoding: "utf8", cwd: safeCwd(process.platform, process.env) },
      (err, stdout) => {
        if (err) return resolve(null);
        const out = String(stdout ?? "").trim();
        resolve(out || null);
      },
    );
  });
}

async function gatherFacts() {
  const gitPath = findOnPath("git", { env: process.env, platform: process.platform });
  const [remote, branch] = await Promise.all([
    git(gitPath, ["remote", "get-url", "origin"]),
    git(gitPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  // Raw here and reduced by `sessionBody` before anything is sent: the full
  // directory and the remote URL (which may carry a token) never leave. The
  // presence `clientId` is NOT here: each watch makes its own (`watchWith`).
  return { hostname: os.hostname(), cwd: process.cwd(), remote, branch };
}

/**
 * This session's registration. Quiet by construction: the only line it ever
 * prints is a successful registration's, once per distinct session id (the
 * first, and again only when the server hands back a NEW id because an End, an
 * eviction or the sweep took the old row), never on a same-id re-registration.
 */
class Presence {
  constructor(config, auth, body) {
    this.config = config;
    this.auth = auth;
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
  async post(renewed = false) {
    let res;
    const token = await this.auth.bearer();
    try {
      res = await fetch(new URL("/api/sessions", this.config.origin), {
        method: "POST",
        headers: { ...requestHeaders(token), "content-type": "application/json" },
        body: JSON.stringify(this.body),
        redirect: "error",
        signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
      });
    } catch {
      // Unreachable. Keep whatever id we had: the row outlives a blip, and the
      // feed that fails alongside will ask again on its next attempt.
      return "unreachable";
    }
    if (res.status === 401 && this.auth.kind !== "env") {
      // A token that expired or was rotated by another session: renew it and
      // ask once more. A renewal that cannot happen yet is a transient.
      await res.body?.cancel().catch(() => {});
      const recovered = await this.auth.recover(token);
      if (recovered === "ok" && !renewed) return this.post(true);
      return recovered === "dead" ? "refused-401" : "unreachable";
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
    if (!id || this.auth.dead) return;
    try {
      await fetch(new URL(`/api/sessions/${id}`, this.config.origin), {
        method: "DELETE",
        headers: requestHeaders(this.auth.token()),
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
async function connect(config, auth, lane, state, onOpen, sessionId) {
  const controller = new AbortController();
  // A dead credential ends every open feed at once.
  const onDead = () => controller.abort();
  auth.signal.addEventListener("abort", onDead, { once: true });
  let idle = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  };
  const started = Date.now();
  let openedAt = null;
  try {
    let res;
    for (let attempt = 0; ; attempt += 1) {
      const token = await auth.bearer();
      const headers = { accept: "text/event-stream", ...requestHeaders(token) };
      const cursor = resumeHeader(state.lastEventId);
      if (cursor !== null) headers["last-event-id"] = cursor;
      // `redirect: "error"`: a redirect is never followed with a bearer key on it.
      res = await fetch(feedUrl(config.origin, lane, sessionId), {
        headers,
        signal: controller.signal,
        redirect: "error",
      });
      if (res.status !== 401) break;
      await res.body?.cancel().catch(() => {});
      // An expired or rotated token is renewed and the feed asked ONCE more;
      // a key from the environment cannot be, and is a dead key at once.
      const recovered = await auth.recover(token);
      if (recovered === "dead") return { kind: "unauthorized" };
      if (recovered !== "ok" || attempt >= 1) return { kind: "failed" };
    }
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
    auth.signal.removeEventListener("abort", onDead);
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
 * One lane's reconnect loop. Resolves when the lane stops for good, or when
 * the watch on the credential from the file stopped (`auth.stopped`). `onlyLane` says no other
 * lane is running, which matters to the nameless message lane: alone, nothing
 * else would ever report a dead key or an outage for it.
 */
async function runLane(config, auth, lane, outage, presence, onlyLane) {
  const state = {
    lastEventId: "",
    burst: new BurstWindow(print, (n) => burstLineFor(lane, n), (fn, ms) => setTimeout(fn, ms).unref()),
  };
  const wait = (ms) => sleep(ms, auth.signal);
  let attempt = 0;
  for (;;) {
    if (auth.stopped) return;
    const sessionId = await presence.beforeConnect();
    if (auth.stopped) return;
    if (lane.kind === "messages" && lane.to === null && !sessionId) {
      // A nameless message lane IS its session (the server rings it for what
      // hinted sends deliver there), so without one it has nothing to ask for
      // and the server would refuse it. What the registration said decides
      // what, if anything, is printed; then wait and try again.
      const outcome = presence.lastOutcome;
      if (outcome === "refused-401" && onlyLane && auth.kind === "env") return stopOnDeadKey();
      if (outcome === "unreachable") {
        // The one lane that would otherwise sit silent through an outage:
        // feed the same memo a failed connect does, so the offline line can print.
        const line = outage.failed(lane, Date.now());
        if (line) print(line);
        await wait(backoffMs(attempt));
        attempt += 1;
        continue;
      }
      outage.answered(lane);
      // A dead key with other lanes running: they say it, and exit.
      if (!noSessionSaid && outcome !== "refused-401") {
        noSessionSaid = true;
        print(NO_SESSION_LINE);
      }
      await wait(TOO_MANY_WATCHERS_WAIT_MS);
      continue;
    }
    if (lane.kind === "messages" && lane.to === null) {
      // Registered again after an outage on this lane: say so if it was said.
      const back = outage.recovered(lane);
      if (back) print(back);
    }
    const ended = await connect(
      config,
      auth,
      lane,
      state,
      () => {
        const line = outage.recovered(lane);
        if (line) print(line);
      },
      sessionId,
    );
    if (auth.stopped) return;
    if (ended.kind === "stopped" && ended.status === 400 && sessionId) {
      // Possibly the session the feed was asked to carry, not the watch
      // itself: never a reason to stop the lane. See `Presence.refused`.
      outage.answered(lane);
      presence.refused(sessionId);
      // Backed off like any other retry, so a refusal that repeats cannot spin
      // the loop against the server.
      await wait(backoffMs(attempt));
      attempt += 1;
      continue;
    }
    if (ended.kind === "unauthorized") {
      // A key from the environment: say so once and exit, as it always did. A
      // credential from the file is already marked dead, and `watchWith` says so.
      if (auth.kind === "env") return stopOnDeadKey();
      return;
    }
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
      if (ended.retryHint) await wait(ended.retryHint);
      continue;
    }
    if (ended.kind === "busy") {
      // Too many feeds open on the account. The server answered, so this is
      // not an outage: wait silently and never feed the offline line.
      outage.answered(lane);
      attempt = 0;
      await wait(TOO_MANY_WATCHERS_WAIT_MS);
      continue;
    }
    if (ended.healthy) attempt = 0;
    const line = outage.failed(lane, Date.now());
    if (line) print(line);
    await wait(backoffMs(attempt));
    attempt += 1;
  }
}

/**
 * Wait until the credentials file holds a usable credential for `origin`,
 * other than the one already refused (`refused`). One `stat` every few
 * seconds; the file is read again only when the stat changes.
 */
async function waitForSignIn(file, origin, refused) {
  let seen = null;
  for (;;) {
    const stamp = statStamp(file);
    if (stamp !== seen) {
      seen = stamp;
      const cred = stamp === "missing" ? null : readCredentials(file);
      if (cred && cred.origin === origin && fingerprint(cred) !== refused) return cred;
    }
    await sleep(SIGN_IN_POLL_MS);
  }
}

/**
 * One watch on one credential: register, run every lane, end the session.
 * Answers the credential's `stopReason` (`refused`, `signed-out` or
 * `replaced`) when it stopped, and `stopped` when every lane stopped for good.
 * Each watch registers with a NEW presence `clientId`: a new sign-in may be
 * another account, and the server refuses a `clientId` that another account
 * holds.
 */
async function watchWith(config, auth, facts, current) {
  const presence = new Presence(config, auth, sessionBody(process.env, { ...facts, clientId: randomUUID() }));
  current.presence = presence;
  current.auth = auth;
  if (auth instanceof FileAuth) auth.watchFile(config.origin);
  try {
    await presence.register();
    const outage = new OutageMemo();
    const onlyLane = config.lanes.length === 1;
    await Promise.all(config.lanes.map((lane) => runLane(config, auth, lane, outage, presence, onlyLane)));
    // Every lane stopped: nothing is watching, so nothing is present.
    await presence.end();
  } finally {
    if (auth instanceof FileAuth) auth.unwatchFile();
  }
  return auth.stopReason ?? "stopped";
}

/** Resolve after `promise` or after `ms`, whichever is first. Never rejects. */
function within(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    Promise.resolve(promise)
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

async function main() {
  const config = readConfig(process.env);
  if (!config.ok) {
    print(config.line);
    return;
  }
  const facts = await gatherFacts();
  const current = { presence: null, auth: null };
  let ending = false;
  const stop = () => {
    // A second signal while the first is still ending the session: go now.
    if (ending) process.exit(0);
    ending = true;
    // A refresh in flight is let finish first (bounded): the server may have
    // rotated the pair already, and an exit before the save would leave the
    // file with a spent refresh token, which the next refresh, after the
    // server's 60-second grace, spends as a replay that revokes the
    // connection.
    within(current.auth?.inFlight, END_TIMEOUT_MS)
      .then(() => current.presence?.end())
      .finally(() => process.exit(0));
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, stop);

  if (config.key) {
    // The environment wins, and behaves exactly as it always has.
    await watchWith(config, new EnvAuth(config.key), facts, current);
    return;
  }

  // The home folder alone decides the place: no environment variable moves it.
  const file = credentialsPath();
  let cred = readCredentials(file);
  if (!cred || cred.origin !== config.origin) {
    // ONE line. After a stopped line below, nothing more is printed while it
    // waits: the person has already been told what to run.
    print(WAITING_FOR_SIGN_IN_LINE);
    cred = await waitForSignIn(file, config.origin, null);
  }
  for (;;) {
    const auth = new FileAuth(file, cred);
    const outcome = await watchWith(config, auth, facts, current);
    current.presence = null;
    current.auth = null;
    if (outcome === "replaced") {
      // A new sign-in is in the file: start on it, with no line.
      cred = readCredentials(file) ?? (await waitForSignIn(file, config.origin, null));
      if (cred.origin !== config.origin) cred = await waitForSignIn(file, config.origin, null);
      continue;
    }
    if (outcome === "signed-out") {
      // Done on purpose: say nothing, and wait for the next sign-in.
      cred = await waitForSignIn(file, config.origin, null);
      continue;
    }
    if (outcome !== "refused") return;
    print(auth.kind === "oauth" ? SIGN_IN_EXPIRED_LINE : SAVED_KEY_REFUSED_LINE);
    // The refused credential stays in the file until a new sign-in replaces
    // it, so the wait skips it rather than starting on it again.
    cred = await waitForSignIn(file, config.origin, fingerprint(auth.cred));
  }
}

main().catch((err) => {
  // Only a bug reaches here. Its class and nothing more: a message is free
  // text, and this line lands in the session's context.
  print(`[passerjack] watch stopped: unexpected ${err instanceof Error ? err.name : "error"}`);
});
