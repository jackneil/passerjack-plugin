/**
 * The plugin's credentials file: where `/passerjack:connect` saves a sign-in
 * and where the watcher finds it. This is what lets a person connect WITHOUT
 * editing a shell profile or restarting Claude Code: a monitor's environment
 * is fixed when Claude Code starts, but a file can appear at any moment, and
 * the watcher checks for it.
 *
 * DEPENDENCY-FREE ON PURPOSE, like `watch-core.mjs`: this ships inside the
 * plugin and runs on whatever Node 18+ the person has. The few facts it copies
 * from the server (the key and refresh-token shapes, the OAuth paths) are
 * pinned to the originals by `tests/unit/passerjack-plugin-connect.test.ts`.
 *
 * TWO SHAPES, one per way of connecting:
 *   { origin, kind: "oauth", clientId, accessToken, refreshToken, accessExpiresAt,
 *     connection?, redirectUri?, tokenEndpoint?, revocationEndpoint? }
 *   { origin, kind: "key", apiKey, connection? }
 * `connection` is a random id that `/passerjack:connect` gives each sign-in. A
 * refresh keeps it, so a watcher can tell a token that another session
 * rotated (same id) from a new sign-in (a new id).
 *
 * THE ORIGIN IS PINNED HERE TOO. A credential whose `origin` is not
 * https://passerjack.com or a localhost address (`originAllowed`) is not a
 * credential: nothing reads it, refreshes it or revokes it at that origin.
 *
 * THE PLACE IS FIXED BY THE HOME FOLDER ONLY (`credentialsPath`). No
 * environment variable chooses it: a repository's checked-in
 * `.claude/settings.json` can set `env` for every process Claude Code starts,
 * this plugin's monitor and the Bash tool included, so a variable that moved
 * the file would let a hostile repository put a 90-day refresh token inside
 * itself (to be committed or synced) or on a network share.
 *
 * The file is 0600 on macOS and Linux, in a folder that is 0700 when this
 * plugin made it. On Windows it lives under the home folder's AppData\Local
 * (never the roaming profile: the sign-in is bound to this machine), which
 * only its owner can read by default.
 *
 * NOTHING HERE PRINTS. A token in a line is a token in the session's context.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { originAllowed } from "./watch-core.mjs";

/** The server's `API_KEY_RE` (`src/lib/api-keys.ts`). An OAuth access token has this shape too. */
export const API_KEY_RE = /^pj_[0-9A-Za-z]{40}$/;
/** The server's `REFRESH_TOKEN_RE` (`src/lib/oauth.ts`). */
export const REFRESH_TOKEN_RE = /^pjr_[0-9a-f]{64}$/;

/** The server's `AUTHORIZATION_SERVER_PATH`, `OAUTH_TOKEN_PATH` and `OAUTH_REVOKE_PATH`. */
export const METADATA_PATH = "/.well-known/oauth-authorization-server";
export const TOKEN_PATH = "/api/oauth/token";
export const REVOKE_PATH = "/api/oauth/revoke";

/**
 * A lock file older than this belongs to a process that died holding it, and
 * is broken. Well above `REFRESH_TIMEOUT_MS`, so a live holder is never
 * mistaken for a dead one.
 */
export const LOCK_STALE_MS = 30_000;

/** How long one refresh request may take. Far under the stale limit. */
export const REFRESH_TIMEOUT_MS = 15_000;

/**
 * An access token with less than this left is refreshed before it is used.
 * The server's lifetime is one hour (`OAUTH_ACCESS_TTL_SECONDS`).
 */
export const REFRESH_EARLY_MS = 5 * 60_000;

/**
 * Where the file lives on this machine. It depends on the home folder and the
 * platform ONLY, never on an environment variable (see the header).
 *
 * `home` and `platform` are for tests in the same process. A program never
 * passes them: production callers call `credentialsPath()` with no argument,
 * and nothing hands this function an environment object.
 *
 * `os.homedir()` reads HOME (POSIX) or USERPROFILE (Windows). That is
 * accepted: a repository that can set HOME for Claude Code has already taken
 * over git and the shell, which read their own settings from HOME. The tests
 * that start the watcher or `connect.mjs` as a program set HOME and
 * USERPROFILE for the child to a temporary folder, for the same reason.
 *
 * @param {{ home?: string, platform?: string }} [options]
 */
export function credentialsPath({ home = os.homedir(), platform = process.platform } = {}) {
  if (platform === "win32") {
    // LOCAL, not roaming: a roaming profile would copy one rotating refresh
    // token to a second PC with no shared lock, and the later refresh there is
    // a replay that revokes the connection.
    return path.win32.join(home, "AppData", "Local", "PasserJack", "credentials.json");
  }
  return path.posix.join(home, ".config", "passerjack", "credentials.json");
}

const isText = (value) => typeof value === "string" && value.length > 0;

function originOf(value) {
  try {
    const url = new URL(value);
    return url.origin === "null" || !originAllowed(url) ? null : url.origin;
  } catch {
    return null;
  }
}

const CONNECTION_RE = /^[0-9a-f]{32}$/;

/** A new `connection` id for a sign-in. */
export function newConnectionId() {
  return crypto.randomBytes(16).toString("hex");
}

/** An optional endpoint, kept only when it is on the credential's own origin. */
function sameOriginUrl(value, origin) {
  if (!isText(value)) return undefined;
  return originOf(value) === origin ? value : undefined;
}

/**
 * A parsed file to a credential, or null for anything that is not one of the
 * two shapes, or whose origin is not PasserJack or this machine. Unknown
 * fields are dropped.
 */
export function parseCredential(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const origin = isText(value.origin) ? originOf(value.origin) : null;
  if (!origin || origin !== value.origin) return null;
  const connection = isText(value.connection) && CONNECTION_RE.test(value.connection) ? value.connection : undefined;
  if (value.kind === "key") {
    if (!isText(value.apiKey) || !API_KEY_RE.test(value.apiKey)) return null;
    const cred = { origin, kind: "key", apiKey: value.apiKey };
    if (connection) cred.connection = connection;
    return cred;
  }
  if (value.kind !== "oauth") return null;
  if (!isText(value.clientId) || value.clientId.length > 200) return null;
  if (!isText(value.accessToken) || !API_KEY_RE.test(value.accessToken)) return null;
  if (!isText(value.refreshToken) || !REFRESH_TOKEN_RE.test(value.refreshToken)) return null;
  if (!isText(value.accessExpiresAt) || Number.isNaN(Date.parse(value.accessExpiresAt))) return null;
  const cred = {
    origin,
    kind: "oauth",
    clientId: value.clientId,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    accessExpiresAt: value.accessExpiresAt,
  };
  if (connection) cred.connection = connection;
  const redirectUri = isText(value.redirectUri) && /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(value.redirectUri) ? value.redirectUri : undefined;
  if (redirectUri) cred.redirectUri = redirectUri;
  const tokenEndpoint = sameOriginUrl(value.tokenEndpoint, origin);
  if (tokenEndpoint) cred.tokenEndpoint = tokenEndpoint;
  const revocationEndpoint = sameOriginUrl(value.revocationEndpoint, origin);
  if (revocationEndpoint) cred.revocationEndpoint = revocationEndpoint;
  return cred;
}

/** The credential in `file`, or null for a missing, unreadable, corrupt or foreign file. Never throws. */
export function readCredentials(file) {
  try {
    return parseCredential(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

/**
 * Write `cred` to `file` atomically: a temporary file beside it, then a
 * rename, so a reader sees the old file or the new one and never half of one.
 * Throws on failure, because a caller that believes it saved a sign-in must
 * not be told so when it did not.
 *
 * The folder is tightened to 0700 only when this call made it. A folder that
 * was already there (made by a person, or another program) is not this
 * plugin's to change. The file itself is always 0600.
 */
export function writeCredentials(file, cred, platform = process.platform) {
  const parsed = parseCredential(cred);
  if (!parsed) throw new Error("not a credential");
  const dir = path.dirname(file);
  const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform !== "win32" && created !== undefined) fs.chmodSync(dir, 0o700);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(parsed, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(temp, file);
    if (platform !== "win32") fs.chmodSync(file, 0o600);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
  return parsed;
}

/** How long a rename may keep being refused before the write fails. */
export const RENAME_RETRY_BUDGET_MS = 5000;

/**
 * Windows refuses a rename over a file another process has open for a moment
 * (an antivirus scan of the new file holds it for longer): try again, with a
 * growing wait, for up to `RENAME_RETRY_BUDGET_MS`. The wait is
 * `Atomics.wait`, which blocks without a busy loop.
 */
function renameWithRetry(from, to) {
  const until = Date.now() + RENAME_RETRY_BUDGET_MS;
  for (let wait = 25; ; wait = Math.min(wait * 2, 500)) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if ((err?.code !== "EPERM" && err?.code !== "EACCES" && err?.code !== "EBUSY") || Date.now() >= until) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(wait, Math.max(1, until - Date.now())));
    }
  }
}

/**
 * Remove temporary files that a write left behind when its process died
 * between the create and the rename: each one may hold a live pair. Call it
 * only while holding the lock, so no write is in progress.
 */
export function removeLeftoverTemps(file) {
  const dir = path.dirname(file);
  const prefix = `.${path.basename(file)}.`;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(prefix) && name.endsWith(".tmp")) fs.rmSync(path.join(dir, name), { force: true });
  }
}

/** Delete the file. True when there was one. */
export function deleteCredentials(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Does this credential need a new access token before it is used? */
export function needsRefresh(cred, now = Date.now()) {
  return cred?.kind === "oauth" && Date.parse(cred.accessExpiresAt) - now < REFRESH_EARLY_MS;
}

/**
 * Is `b` the same sign-in as `a`, maybe with rotated tokens? Same origin and
 * kind, and the same key, or the same client and `connection` id. A new
 * sign-in (another account, or the same one again) is not.
 */
export function sameSignIn(a, b) {
  if (!a || !b || a.origin !== b.origin || a.kind !== b.kind) return false;
  if (a.kind === "key") return a.apiKey === b.apiKey;
  return a.clientId === b.clientId && (a.connection ?? null) === (b.connection ?? null);
}

/** What identifies one credential's current tokens. */
export function fingerprint(cred) {
  return cred.kind === "oauth" ? `oauth:${cred.refreshToken}:${cred.accessToken}` : `key:${cred.apiKey}`;
}

/** The token a request carries for this credential. */
export function bearerOf(cred) {
  return cred.kind === "oauth" ? cred.accessToken : cred.apiKey;
}

/** One endpoint of `cred`, the saved one or the server's fixed path, on the credential's own origin. */
export function endpointOf(cred, which) {
  const saved = which === "token" ? cred.tokenEndpoint : cred.revocationEndpoint;
  return saved ?? new URL(which === "token" ? TOKEN_PATH : REVOKE_PATH, cred.origin).toString();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` while holding `<file>.lock`, created with O_EXCL so exactly one
 * process on the machine holds it. The holder writes a random token into it
 * and removes it only while it still holds that token, in `finally`.
 *
 * A lock older than `staleMs` belongs to a process that died holding it. It is
 * taken over ATOMICALLY: renamed to a name of this call's own, and removed
 * only when the renamed file is the stale one that was seen (same inode and
 * time). When it is not (another process took the lock between the stat and
 * the rename), it is put back with `link`, which refuses to replace a lock
 * that a third process made meanwhile. A takeover that fails (a folder that
 * became read-only, a file another user owns) is a wait, never a busy loop:
 * every pass checks the deadline and sleeps.
 *
 * Everything `fn` does must take less than `LOCK_STALE_MS`, or another
 * process may take the lock over while `fn` still runs.
 *
 * @param {string} file
 * @param {() => Promise<any>} fn
 * @param {{ staleMs?: number, waitMs?: number }} [options]
 */
export async function withLock(file, fn, { staleMs = LOCK_STALE_MS, waitMs = staleMs + 10_000 } = {}) {
  const lock = `${file}.lock`;
  const token = crypto.randomBytes(16).toString("hex");
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await fsp.open(lock, "wx", 0o600);
      try {
        await handle.writeFile(token);
      } finally {
        await handle.close();
      }
      break;
    } catch (err) {
      if (err?.code === "ENOENT") {
        // The folder is not there yet. A failure to make it is real.
        await fsp.mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
        continue;
      }
      if (err?.code !== "EEXIST") throw err;
    }
    if (await takeOverStale(lock, token, staleMs)) continue;
    if (Date.now() > deadline) throw new Error("credentials lock timeout");
    await sleep(50 + Math.floor(Math.random() * 100));
  }
  try {
    return await fn();
  } finally {
    try {
      if ((await fsp.readFile(lock, "utf8")) === token) await fsp.unlink(lock);
    } catch {
      // Already gone (taken over as stale by another process): nothing to release.
    }
  }
}

/** True when a stale lock was removed and the caller may try at once. */
async function takeOverStale(lock, token, staleMs) {
  let seen;
  try {
    seen = await fsp.stat(lock);
  } catch {
    return false; // Gone since the open: the next pass tries again, after the wait.
  }
  if (Date.now() - seen.mtimeMs <= staleMs) return false;
  const aside = `${lock}.${token}.stale`;
  try {
    await fsp.rename(lock, aside);
  } catch {
    return false; // Another process took it over first, or this one cannot: wait.
  }
  let moved = null;
  try {
    moved = await fsp.stat(aside);
  } catch {
    // Vanished: treat as removed.
  }
  if (moved && (moved.ino !== seen.ino || moved.mtimeMs !== seen.mtimeMs)) {
    // A FRESH lock was moved: put it back for its holder. `link` refuses when
    // a third process made a lock meanwhile, and then that one stands.
    await fsp.link(aside, lock).catch(() => {});
    await fsp.unlink(aside).catch(() => {});
    return false;
  }
  await fsp.unlink(aside).catch(() => {});
  return true;
}

/**
 * A token response to the fields this file keeps, or null when it is not a
 * real one. `now` is when the request was SENT, so the saved expiry is never
 * later than the server's.
 */
export function tokensFrom(body, now) {
  if (!body || typeof body !== "object") return null;
  if (!isText(body.access_token) || !API_KEY_RE.test(body.access_token)) return null;
  if (!isText(body.refresh_token) || !REFRESH_TOKEN_RE.test(body.refresh_token)) return null;
  const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    accessExpiresAt: new Date(now + seconds * 1000).toISOString(),
  };
}

/**
 * Spend `cred`'s refresh token at the token endpoint. Answers
 * `{ kind: "ok", tokens }`, `{ kind: "refused" }` (the server said no: the
 * connection was revoked, expired or replaced) or `{ kind: "transient" }` (no
 * answer, a 429, a 5xx, a page that is not a token response). Call it only
 * under `withLock`: see `refreshUnderLock`.
 */
export async function requestRefresh(cred, fetchImpl = fetch) {
  if (cred?.kind !== "oauth") return { kind: "refused" };
  const sentAt = Date.now();
  let res;
  try {
    res = await fetchImpl(endpointOf(cred, "token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: cred.refreshToken,
        client_id: cred.clientId,
      }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch {
    return { kind: "transient" };
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON.
  }
  if (res.ok) {
    const tokens = tokensFrom(body, sentAt);
    return tokens ? { kind: "ok", tokens } : { kind: "transient" };
  }
  // The token route answers every refusal with one 400 (`invalid_grant`), and
  // a 401 is never a transient either.
  if (res.status === 400 || res.status === 401) return { kind: "refused" };
  return { kind: "transient" };
}

/**
 * Get a working credential after `staleToken` was refused (a 401) or is about
 * to expire, with at most ONE refresh per machine. Under the lock it re-reads
 * the file first: when another session already refreshed (the file holds a
 * different token that is not itself due), that answer is used and no refresh
 * token is spent. Otherwise it refreshes and saves the rotated pair before it
 * lets go of the lock, so no other process can ever read the old refresh
 * token after the server rotated it.
 *
 * `unsaved` is a pair this process rotated earlier and could not save: `{
 * cred, replaces }`, where `replaces` is the refresh token it replaced. When
 * the file still holds `replaces`, `unsaved.cred` is written first and used.
 *
 * Answers `{ kind: "ok", cred, saved }`, `{ kind: "refused" }` (the
 * credential is dead: the refresh was refused, or the saved key IS the stale
 * one), `{ kind: "gone" }` (no usable file any more: signed out) or `{ kind:
 * "transient" }`. `saved: false` means the server rotated the pair and the
 * file could not be written: the caller keeps `cred` in memory and passes it
 * back as `unsaved`, because the server has already spent the old refresh
 * token and the new pair is the only one that works.
 *
 * Everything under the lock is bounded: one refresh (`REFRESH_TIMEOUT_MS`)
 * and one write (`RENAME_RETRY_BUDGET_MS`), together well under
 * `LOCK_STALE_MS`.
 *
 * @param {string} file
 * @param {{ staleToken: string, refresh: (cred: any) => Promise<any>, now?: () => number,
 *   unsaved?: { cred: any, replaces: string } | null }} options
 */
export async function refreshUnderLock(file, { staleToken, refresh, now = Date.now, unsaved = null }) {
  try {
    return await withLock(file, async () => {
      let current = readCredentials(file);
      // The refresh token that the FILE holds, whatever this process holds in memory.
      let inFile = current?.kind === "oauth" ? current.refreshToken : null;
      if (unsaved && current?.kind === "oauth" && current.refreshToken === unsaved.replaces && sameSignIn(current, unsaved.cred)) {
        try {
          current = writeCredentials(file, unsaved.cred);
          inFile = current.refreshToken;
        } catch {
          current = unsaved.cred;
        }
      }
      if (!current) return { kind: "gone" };
      if (bearerOf(current) !== staleToken && !needsRefresh(current, now())) return { kind: "ok", cred: current, saved: true };
      if (current.kind !== "oauth") return { kind: "refused" };
      const out = await refresh(current);
      if (out.kind !== "ok") return out;
      const next = parseCredential({ ...current, ...out.tokens });
      try {
        removeLeftoverTemps(file);
        return { kind: "ok", cred: writeCredentials(file, next), saved: true };
      } catch {
        // The server rotated the pair and the file could not take it. The old
        // refresh token is spent, so the new pair goes back to the caller,
        // never into the bin.
        return { kind: "ok", cred: next, saved: false, replaces: inFile };
      }
    });
  } catch {
    // The lock timed out, or the folder could not be read: try again later.
    return { kind: "transient" };
  }
}

/** How long a refused refresh waits before it is tried once more. */
export const REFUSED_RETRY_MS = 2000;

/**
 * `refreshUnderLock`, and ONE more try after `retryMs` when the answer is
 * refused. The token route answers a lost race (`race`) with the same 400 as
 * a real refusal. The second try re-reads the file (another session, or a new
 * `/passerjack:connect`, may have written it meanwhile), and a refresh token
 * spent again inside the server's 60-second grace gets the winner's pair. A
 * real refusal is refused again. The wait is OUTSIDE the lock.
 *
 * @param {string} file
 * @param {Parameters<typeof refreshUnderLock>[1] & { retryMs?: number }} options
 */
export async function renewCredential(file, { retryMs = REFUSED_RETRY_MS, ...options }) {
  const first = await refreshUnderLock(file, options);
  if (first.kind !== "refused") return first;
  await sleep(retryMs);
  return refreshUnderLock(file, options);
}
