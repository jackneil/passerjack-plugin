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
 * set (see `readConfig`), BUT NOT OVER ANOTHER ACCOUNT (D8, #787i, plugin
 * 0.4.0): when the credentials file also holds a sign-in for this origin,
 * the watcher asks `GET /api/me` with each, at start and whenever that
 * sign-in changes. Different accounts: it registers nothing, writes no link
 * (so every hook does nothing) and prints ONE line, `ACCOUNTS_DIFFER_LINE`.
 * The same account: the key runs the watch, and the link carries the
 * remote-answer mark, so the request hook may take the owner's answers. A
 * key with no saved sign-in runs the watch with NO mark: messages and status
 * work, and every permission prompt stays at the terminal, so a repository
 * that sets the key cannot press Allow on this computer from another
 * account. A saved sign-in alone always carries the mark. Otherwise the credentials file that
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
 * session id so the server can keep it marked present. The `clientId` comes
 * from the Claude Code session and the sign-in (`sessionClientId`), so a
 * restarted or resumed Claude Code comes back to the SAME row. A registration
 * that fails prints nothing and the watch runs on without presence.
 *
 * THE WATCHER NEVER ENDS ITS SESSION ON THE SERVER. SIGINT, SIGTERM and SIGHUP
 * (Claude Code closing), a new sign-in and every lane stopping all leave the
 * row in place: `DELETE /api/sessions/<id>` cascades the session's Agents page
 * thread away (migration 0138), with an owner message that the session did
 * not read yet and a reply that the owner did not read yet. The row goes
 * quiet once its feed is gone and expires a day after its last sign of life;
 * the agent bridge does the same (`bridge.mjs`, session end). The signal
 * handlers are the exit path (the lanes never resolve on their own, so
 * `beforeExit` would never fire): they let a refresh in flight finish, remove
 * this watcher's link file and exit.
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
  readAccount,
  readCredentials,
  remoteMark,
  renewCredential,
  requestRefresh,
  sameSignIn,
  signInIdentity,
} from "./credentials.mjs";
import { findOnPath, safeCwd } from "./programs.mjs";
import { claudeKey, linkedElsewhere, linkHolder, linksDir, processAlive, removeLink, sessionClientId, sweepLinks, writeLink } from "./session-link.mjs";
import {
  ACCOUNTS_DIFFER_LINE,
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
  reprintsRegistered,
  resumeHeader,
  sessionBody,
  sessionIdFrom,
} from "./watch-core.mjs";

const VERSION = "0.4.0";

/**
 * Where this watcher tells the plugin's hooks which session it holds
 * (`session-link.mjs`): the folder beside the credentials file, and the
 * Claude Code process id it runs under. No credential is ever in that file.
 */
const LINKS_DIR = linksDir();
const CLAUDE_KEY = claudeKey(process.env);

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

/** The least time between two renewals that `keepFresh` starts. */
const KEEP_FRESH_RETRY_MS = 60_000;

/** Statuses asking again will never fix: say so once and stop that lane. */
const PERMANENT = new Set([400, 403, 404]);

/** How long a registration may take before the watch goes on without it. */
const REGISTER_TIMEOUT_MS = 5000;

/** The most the way out waits for a refresh in flight, so its rotated pair is saved. */
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
 * `remote` is its remote-answer mark when the watcher proved that the saved
 * sign-in is of the same account, else null (D8). Its watch stops only with
 * `different`: the saved sign-in changed to another account.
 */
class EnvAuth {
  constructor(key, remote = null) {
    this.key = key;
    this.kind = "env";
    this.identity = signInIdentity({ kind: "env", key });
    this.remote = remote;
    this.dead = false;
    this.stopReason = null;
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.inFlight = null;
  }

  get stopped() {
    return this.stopReason !== null;
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

  stop(reason) {
    if (this.stopReason !== null) return;
    this.stopReason = reason;
    this.controller.abort();
  }
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
    /** The sign-in this watch runs on; a rotated pair keeps it, a new sign-in is a new watch. */
    this.identity = signInIdentity(cred);
    /** The saved sign-in is the bearer, so the request hook may take the owner's answers (D8). */
    this.remote = remoteMark(this.identity);
    this.dead = false;
    this.stopReason = null;
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.inFlight = null;
    /** A rotated pair that the file could not take: see `refreshUnderLock`. */
    this.unsaved = null;
    this.fileTimer = null;
    this.fileStamp = statStamp(file);
    /** When `keepFresh` last tried a renewal, so a failing one is tried once a minute and no more. */
    this.lastKeepFresh = 0;
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
      this.keepFresh();
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

  /**
   * Renew the sign-in ahead of its expiry even while no connect asks for a
   * token. The plugin's hooks read the access token from the file and never
   * renew it themselves (`hook.mjs`: a short process cannot keep a rotated
   * pair it failed to save), and a connect asks only about every fourteen
   * minutes, so without this the file could hold a token that has run out
   * for minutes at a time and each hook in that time would post nothing.
   * The same single-flight renewal, under the machine's lock, as a connect.
   */
  keepFresh() {
    if (this.stopped || this.inFlight || !needsRefresh(this.cred)) return;
    const now = Date.now();
    if (now - this.lastKeepFresh < KEEP_FRESH_RETRY_MS) return;
    this.lastKeepFresh = now;
    void this.recover(this.token());
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
    /** The `clientId` this watch was given (`sessionClientId`); see the 409 in `post`. */
    this.derivedClientId = body.clientId ?? null;
    /** True once a 409 for the derived id was answered by registering with a random one. */
    this.fellBack = false;
    /** True once this watch left a row that another Claude Code process holds (`splitIfShared`). */
    this.splitOff = false;
    this.id = null;
    this.confirmedAt = 0;
    this.inFlight = null;
    this.disabled = false;
    this.announcedId = null;
    /** The session id the link file names now, or null when there is none. */
    this.linkedId = null;
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
  async post(renewed = false, fallback = false) {
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
      if (recovered === "ok" && !renewed) return this.post(true, fallback);
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
    if (res.status === 409 && !fallback && !this.fellBack && this.derivedClientId && this.body.clientId === this.derivedClientId) {
      // The derived id is held by another credential of this account (a row
      // from an earlier sign-in that the hash did not tell apart). A 409 also
      // means the session cap, so the random id is kept only when it works.
      const derived = this.body.clientId;
      this.body = { ...this.body, clientId: randomUUID() };
      const outcome = await this.post(renewed, true);
      if (outcome === "ok") {
        this.fellBack = true;
        return outcome;
      }
      this.body = { ...this.body, clientId: derived };
      return outcome;
    }
    const id = res.ok ? sessionIdFrom(answer) : null;
    if (id && this.mayShare() && linkedElsewhere(LINKS_DIR, CLAUDE_KEY, id)) {
      // Another running Claude Code process (a second terminal on a resumed
      // session) holds this row: register a row of our own, before any link
      // or line names the shared one (`linkedElsewhere`).
      this.splitOff = true;
      this.body = { ...this.body, clientId: randomUUID() };
      return this.post(renewed, true);
    }
    this.id = id;
    this.confirmedAt = id ? Date.now() : 0;
    this.relink();
    if (id && id !== this.announcedId && reprintsRegistered("new-id")) {
      this.announcedId = id;
      print(registeredLine({ ...this.body, id }));
    }
    if (id) return "ok";
    return res.status === 401 ? "refused-401" : "refused-other";
  }

  /**
   * Keep the link file in step with the session this watcher holds, so the
   * plugin's hooks post the turn's state for the right session, and for none
   * when it has none.
   */
  relink() {
    if (this.id === this.linkedId) return;
    if (this.id) {
      this.linkWritten(writeLink(this.linkFor(this.id)));
    } else {
      // Only this watcher's own link: another watcher of the same Claude Code
      // process (a plugin reload) may hold the file now.
      removeLink(LINKS_DIR, CLAUDE_KEY, process.pid);
    }
    this.linkedId = this.id;
  }

  /**
   * Put the link back when it is gone, or names a watcher that has exited or
   * another session: a second watcher of this Claude Code process that
   * exited took it with it. A live other watcher's link for the same session
   * is left alone. One small read, before each connect.
   */
  ensureLink() {
    if (!this.id || !CLAUDE_KEY) return;
    const held = linkHolder(LINKS_DIR, CLAUDE_KEY);
    if (held && held.sessionId === this.id && (held.watcherPid === process.pid || processAlive(held.watcherPid))) {
      // This watcher's own link keeps its remote-answer mark in step (D8).
      if (held.watcherPid !== process.pid || held.remote === (this.auth.remote ?? null)) return;
    }
    this.linkWritten(writeLink(this.linkFor(this.id)));
    this.linkedId = this.id;
  }

  /** The link for session `id`: this watcher, and the remote-answer mark of its bearer or none (D8). */
  linkFor(id) {
    return { dir: LINKS_DIR, key: CLAUDE_KEY, sessionId: id, origin: this.config.origin, watcherPid: process.pid, remote: this.auth.remote ?? null };
  }

  /** The remote-answer mark changed (the saved sign-in changed): write the link again at once. */
  refreshLink() {
    if (this.disabled || !this.id || !CLAUDE_KEY) return;
    this.linkWritten(writeLink(this.linkFor(this.id)));
    this.linkedId = this.id;
  }

  /** Whether this watch still uses the derived `clientId`, so it may share a row with another process. */
  mayShare() {
    return Boolean(CLAUDE_KEY && !this.splitOff && this.derivedClientId && this.body.clientId === this.derivedClientId);
  }

  /**
   * The watch's few-second check (`watchWith`): put a lost link back at once
   * (a second watcher of this process that exited took it), not at the next
   * connect up to fourteen minutes later, and leave a row that a Claude Code
   * process with a LOWER key also holds. Two terminals that started in the
   * same instant both registered before either link was written; the lower
   * key keeps the row, the higher one moves. Never throws.
   */
  tick() {
    if (this.disabled || !this.id) return;
    this.ensureLink();
    if (this.mayShare() && linkedElsewhere(LINKS_DIR, CLAUDE_KEY, this.id, { lowerThan: CLAUDE_KEY })) {
      this.splitOff = true;
      this.body = { ...this.body, clientId: randomUUID() };
      this.confirmedAt = 0;
      void this.register();
    }
  }

  /**
   * A session says `waits: true` only while its hooks can find it. When the
   * link cannot be written (a folder that is not writable), the hooks post
   * nothing, no `idle` ever comes, and a question push that the server holds
   * for the idle would never go: register again at once with an explicit
   * `waits: false` (a re-registration keeps a `waits` it does not send), so
   * questions push at once. A later link that lands says `waits: true` again.
   */
  linkWritten(ok) {
    if (!CLAUDE_KEY || this.body.waits === ok) return;
    this.body = { ...this.body, waits: ok };
    this.confirmedAt = 0;
    // After the registration in flight (this runs inside it) has finished.
    setTimeout(() => {
      if (!this.disabled) void this.register();
    }, 0).unref?.();
  }

  /** Print the `registered` line again for this session, when `reprintsRegistered(reason)` says so. */
  announceAgain(reason) {
    if (this.id && !this.disabled && reprintsRegistered(reason)) print(registeredLine({ ...this.body, id: this.id }));
  }

  /** The session id a connect should carry, registering again first unless that just happened. */
  async beforeConnect() {
    if (this.disabled) return null;
    if (Date.now() - this.confirmedAt >= FRESH_MS) await this.register();
    if (!this.disabled) this.ensureLink();
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
    this.relink();
  }

  /**
   * The watch is over (Claude Code closes, a new sign-in, every lane
   * stopped): stop using the session and remove this watcher's link. NO
   * `DELETE /api/sessions/<id>`: it would cascade the Agents page thread away
   * with the owner's unread words. The row goes quiet and expires a day after
   * its last sign of life. Never throws.
   */
  leave() {
    this.disabled = true;
    this.id = null;
    this.relink();
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
        const out = lineForFrame(lane, record, sessionId);
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
  // The back-online line, and beside it this session's id again (`reprintsRegistered`).
  const sayBack = (line) => {
    print(line);
    presence.announceAgain("back-online");
  };
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
      if (back) sayBack(back);
    }
    const ended = await connect(
      config,
      auth,
      lane,
      state,
      () => {
        const line = outage.recovered(lane);
        if (line) sayBack(line);
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
      if (back) sayBack(back);
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
 * One watch on one credential: register, run every lane, leave the session
 * (never delete it). Answers the credential's `stopReason` (`refused`,
 * `signed-out` or `replaced`) when it stopped, and `stopped` when every lane
 * stopped for good. The presence `clientId` is the Claude Code session's and
 * this sign-in's (`sessionClientId`): the same after a restart or a resume on
 * the same sign-in, and a NEW one for a new sign-in, which may be another
 * account (the server refuses a `clientId` that another credential holds).
 */
async function watchWith(config, auth, facts, current, saved = null) {
  const clientId = sessionClientId(process.env, { origin: config.origin, identity: auth.identity });
  const presence = new Presence(config, auth, sessionBody(process.env, { ...facts, clientId }));
  current.presence = presence;
  current.auth = auth;
  if (auth instanceof FileAuth) auth.watchFile(config.origin);
  const savedTimer = auth instanceof EnvAuth && saved ? watchSavedSignIn(config, auth, presence, saved) : null;
  const linkTimer = setInterval(() => presence.tick(), SIGN_IN_POLL_MS);
  linkTimer.unref?.();
  try {
    await presence.register();
    const outage = new OutageMemo();
    const onlyLane = config.lanes.length === 1;
    await Promise.all(config.lanes.map((lane) => runLane(config, auth, lane, outage, presence, onlyLane)));
    // Every lane stopped: nothing is watching. The row goes quiet; it is never deleted.
    presence.leave();
  } finally {
    clearInterval(linkTimer);
    if (savedTimer) clearInterval(savedTimer);
    if (auth instanceof FileAuth) auth.unwatchFile();
  }
  return auth.stopReason ?? "stopped";
}

/**
 * D8: which account the environment's key and the saved sign-in belong to.
 * Answers `alone` (no saved sign-in for this origin, or one that the server
 * refused), `same` with the saved sign-in's `identity`, `different`,
 * `dead-key` (the server refused the key: today's line and exit) or
 * `unknown` (no answer yet: ask again later). Only `same` ever gives the
 * request hook the owner's answers. `holder.auth` keeps ONE `FileAuth` for
 * the saved sign-in, so a token that has run out is renewed under the
 * machine's lock (never a second spend of one refresh token), and a pair the
 * file could not take stays in memory for the next renewal.
 */
async function compareAccounts(config, file, holder) {
  const cred = readCredentials(file);
  if (!cred || cred.origin !== config.origin) {
    holder.auth = null;
    return { kind: "alone" };
  }
  const userAgent = `passerjack-claude-plugin/${VERSION}`;
  const key = await readAccount(config.origin, config.key, { userAgent });
  if (key.kind === "refused" && key.status === 401) return { kind: "dead-key" };
  // A key that may not read the account: the lanes say what the server says,
  // and the key gets no remote answers.
  if (key.kind === "refused") return { kind: "alone" };
  if (key.kind !== "ok") return { kind: "unknown" };
  if (!holder.auth || holder.auth.stopReason === "replaced" || holder.auth.stopReason === "signed-out" || !sameSignIn(holder.auth.cred, cred)) {
    holder.auth = new FileAuth(file, cred);
  }
  const auth = holder.auth;
  if (auth.stopped) return auth.stopReason === "refused" ? { kind: "alone" } : { kind: "unknown" };
  let token = await auth.bearer();
  let account = auth.stopped ? null : await readAccount(config.origin, token, { userAgent });
  if (account?.kind === "refused" && account.status === 401) {
    const renewed = await auth.recover(token);
    if (renewed === "transient") return { kind: "unknown" };
    token = auth.token();
    account = auth.stopped ? null : await readAccount(config.origin, token, { userAgent });
  }
  if (auth.stopped) return auth.stopReason === "refused" ? { kind: "alone" } : { kind: "unknown" };
  if (!account || account.kind === "transient") return { kind: "unknown" };
  // A saved key that the server refused is no sign-in.
  if (account.kind === "refused") return { kind: "alone" };
  return account.id === key.id ? { kind: "same", identity: auth.identity } : { kind: "different" };
}

/**
 * D8 while the key's watch runs: one `stat` of the credentials file every few
 * seconds. A rotated pair of the sign-in already compared changes nothing. A
 * new sign-in, or one that went, is compared again, with NO remote answers
 * until the answer is in: `same` writes the mark into the link, `alone` takes
 * it out, `different` stops the watch (the caller prints the one line), and
 * `unknown` asks again on the next tick.
 */
function watchSavedSignIn(config, auth, presence, saved) {
  let stamp = statStamp(saved.file);
  let due = false;
  let busy = false;
  const setRemote = (mark) => {
    if (auth.remote === mark) return;
    auth.remote = mark;
    presence.refreshLink();
  };
  const timer = setInterval(async () => {
    const now = statStamp(saved.file);
    if (now !== stamp) {
      stamp = now;
      const cred = now === "missing" ? null : readCredentials(saved.file);
      const usable = cred && cred.origin === config.origin ? cred : null;
      // A rotated pair (or a stat that changed for nothing) of the same sign-in.
      if ((usable ? signInIdentity(usable) : null) !== saved.identity || due) due = true;
    }
    if (!due || busy || auth.stopped) return;
    busy = true;
    try {
      setRemote(null);
      const verdict = await compareAccounts(config, saved.file, saved.holder);
      if (verdict.kind === "unknown" || auth.stopped) return;
      due = false;
      if (verdict.kind === "different") return auth.stop("different");
      saved.identity = verdict.kind === "same" ? verdict.identity : null;
      setRemote(verdict.kind === "same" ? remoteMark(auth.identity) : null);
    } catch {
      // Asked again on the next tick.
    } finally {
      busy = false;
    }
  }, SIGN_IN_POLL_MS);
  timer.unref?.();
  return timer;
}

/** Wait until the credentials file's `stat` is not `stamp` any more. */
async function fileChanged(file, stamp) {
  while (statStamp(file) === stamp) await sleep(SIGN_IN_POLL_MS);
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
  // Link files a crashed session left behind, days old: gone before this one writes its own.
  sweepLinks(LINKS_DIR);
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
      .then(() => current.presence?.leave())
      .finally(() => process.exit(0));
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, stop);

  // The home folder alone decides the place: no environment variable moves it.
  const file = credentialsPath();

  if (config.key) {
    // The environment wins, but never over ANOTHER account (D8).
    const holder = { auth: null };
    let said = false;
    let attempt = 0;
    for (;;) {
      const stamp = statStamp(file);
      const verdict = await compareAccounts(config, file, holder);
      if (verdict.kind === "dead-key") return stopOnDeadKey();
      if (verdict.kind === "unknown") {
        // No answer yet: nothing is registered until the accounts are known.
        await sleep(backoffMs(attempt));
        attempt += 1;
        continue;
      }
      attempt = 0;
      if (verdict.kind === "different") {
        if (!said) print(ACCOUNTS_DIFFER_LINE);
        said = true;
        await fileChanged(file, stamp);
        continue;
      }
      said = false;
      const auth = new EnvAuth(config.key, verdict.kind === "same" ? remoteMark(signInIdentity({ kind: "env", key: config.key })) : null);
      const saved = { file, holder, identity: verdict.kind === "same" ? verdict.identity : null };
      const outcome = await watchWith(config, auth, facts, current, saved);
      current.presence = null;
      current.auth = null;
      // The saved sign-in changed to another account: the next pass says so.
      if (outcome === "different") continue;
      return;
    }
  }

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
