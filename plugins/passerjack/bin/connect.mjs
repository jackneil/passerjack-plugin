#!/usr/bin/env node
/**
 * `/passerjack:connect`: connect this machine's Claude Code to PasserJack with
 * NO shell profile, NO copied key and NO restart, on macOS, Windows and Linux.
 *
 * The default is a browser sign-in (OAuth 2.1 with PKCE, a loopback redirect
 * and dynamic client registration, the same flow `claude mcp add` uses). It
 * writes the credentials file (`credentials.mjs`), and the watcher, which
 * checks for that file every few seconds, starts on its own.
 *
 *   node connect.mjs                  sign in through the browser
 *   node connect.mjs --relay <url>    hand the waiting sign-in the address of the
 *                                     page after Connect, from a browser on
 *                                     ANOTHER computer (SSH, a server)
 *   node connect.mjs --paste          save an API key from the clipboard
 *   node connect.mjs --paste <file>   save an API key from a file
 *   node connect.mjs --status         say whether this machine is connected
 *   node connect.mjs --sign-out       revoke the sign-in and delete the file
 *
 * Every line it prints starts with `[passerjack]` and goes to the session's
 * context through the Bash tool, so NO LINE CARRIES A TOKEN, a key, a code or
 * the clipboard's text. The one address it prints (the sign-in page, so a
 * person can open it by hand) carries a PKCE challenge and a state, neither of
 * which can be spent. The address that `--relay` gets carries a code, which
 * is single-use and bound by PKCE to a verifier that only the waiting process
 * holds, so it is worth nothing to anybody else.
 *
 * DEPENDENCY-FREE, Node 18+, like the rest of `bin/`. Every outside effect
 * (the browser, the clipboard, the network, the clock, the output) is a
 * parameter of `run`, so `tests/unit/passerjack-plugin-connect.test.ts` drives
 * the whole flow against a stub server.
 */

import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  METADATA_PATH,
  bearerOf,
  credentialsPath,
  deleteCredentials,
  endpointOf,
  needsRefresh,
  newConnectionId,
  readCredentials,
  removeLeftoverTemps,
  renewCredential,
  requestRefresh,
  tokensFrom,
  withLock,
  writeCredentials,
} from "./credentials.mjs";
import { findOnPath, programPath, safeCwd } from "./programs.mjs";
import { LINE_PREFIX, oneLine, originAllowed } from "./watch-core.mjs";

/**
 * What the sign-in asks for: `read` (the watcher's feeds and its session
 * registration need nothing more) and a refresh token. Never `write`, never
 * `secrets`: the consent screen shows the person exactly this.
 */
export const CONNECT_SCOPE = "read offline_access";

/**
 * How long the sign-in waits for the person to press Connect. Long enough for
 * a new person to make an account first (a sign-in mail and its link). Not
 * longer, because the foreground fallback in `commands/connect.md` must wait
 * longer than this, and the Bash tool's foreground limit is 600000 ms.
 */
export const SIGN_IN_TIMEOUT_MS = 9 * 60_000;

/** The server's `MAX_CLIENT_NAME_CHARS`. */
const MAX_CLIENT_NAME_CHARS = 120;

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * How long `--relay` waits for the page. The waiting sign-in may first wait
 * for the lock (up to `LOCK_STALE_MS` plus 10 s), then exchange the code.
 */
const RELAY_TIMEOUT_MS = 60_000;

const USAGE = `${LINE_PREFIX} usage: /passerjack:connect [--paste [file] | --status | --sign-out | --relay <address>]`;

/** A PasserJack key anywhere in a text, bounded on both sides. */
const KEY_IN_TEXT_RE = /(?<![0-9A-Za-z_])pj_[0-9A-Za-z]{40}(?![0-9A-Za-z])/g;

/** A key file is a few dozen bytes. A file larger than this is not one, and is refused before it is read. */
const MAX_KEY_FILE_BYTES = 64 * 1024;

/** The name the consent screen and Settings > Agents > Connected apps show for this machine. */
export function clientName(hostname) {
  const host = oneLine(hostname, 80) ?? "this computer";
  return `PasserJack for Claude Code on ${host}`.slice(0, MAX_CLIENT_NAME_CHARS);
}

/**
 * The program and argument list that open `url` in the default browser. Never
 * a shell. On Windows the program is the System32 copy by its absolute path
 * (see `programs.mjs`); elsewhere it is a name that `findOnPath` turns into an
 * absolute path from absolute PATH entries only.
 *
 * @param {string} platform
 * @param {string} url
 * @param {Record<string, string | undefined>} [env]
 * @returns {[string, string[]]}
 */
export function openCommand(platform, url, env = process.env) {
  if (platform === "darwin") return ["open", [url]];
  // `start` is a cmd.exe builtin and would need a shell, which would read the
  // `&` in the address. rundll32 takes the address as one argument.
  if (platform === "win32") return [programPath("rundll32", { env, platform }), ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

/** `cmd` as an absolute path: kept when it is one, else looked up in absolute PATH entries. Null when not found. */
function resolveProgram(cmd, platform, env) {
  if (platform === "win32" ? /^[A-Za-z]:[\\/]/.test(cmd) : path.posix.isAbsolute(cmd)) return cmd;
  return findOnPath(cmd, { env, platform });
}

function defaultOpenBrowser(platform, env) {
  return (url) => {
    const [cmd, args] = openCommand(platform, url, env);
    const program = resolveProgram(cmd, platform, env);
    if (!program) return; // No opener on this machine: the printed address is the way in.
    try {
      const child = spawn(program, args, { stdio: "ignore", detached: true, windowsHide: true, cwd: safeCwd(platform, env) });
      child.on("error", () => {});
      child.unref();
    } catch {
      // The opener would not start: the printed address is the way in.
    }
  };
}

function execTextFor(platform, env) {
  return (cmd, args) =>
    new Promise((resolve, reject) => {
      const program = resolveProgram(cmd, platform, env);
      if (!program) {
        reject(Object.assign(new Error("not found"), { code: "ENOENT" }));
        return;
      }
      execFile(
        program,
        args,
        { timeout: 5000, windowsHide: true, encoding: "utf8", maxBuffer: 1 << 20, cwd: safeCwd(platform, env) },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(String(stdout ?? ""));
        },
      );
    });
}

/**
 * The clipboard's text, from the first tool that answers with some, or null.
 * macOS `pbpaste`; Windows PowerShell's `Get-Clipboard` (the System32 copy);
 * Linux `wl-paste` (Wayland), then `xclip`, then `xsel` (X11). Each is an
 * argument list, never a shell.
 *
 * @param {string} platform
 * @param {(cmd: string, args: string[]) => Promise<string>} [exec]
 * @param {Record<string, string | undefined>} [env]
 */
export async function readClipboard(platform, exec = execTextFor(platform, process.env), env = process.env) {
  const tries =
    platform === "darwin"
      ? [["pbpaste", []]]
      : platform === "win32"
        ? [[programPath("powershell", { env, platform }), ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"]]]
        : [
            ["wl-paste", ["--no-newline"]],
            ["xclip", ["-o", "-selection", "clipboard"]],
            ["xsel", ["-b", "-o"]],
          ];
  for (const [cmd, args] of tries) {
    try {
      const out = await exec(cmd, args);
      if (typeof out === "string" && out.trim()) return out;
    } catch {
      // Not installed, or no display: the next one.
    }
  }
  return null;
}

/**
 * The one PasserJack key in `text`, or why there is none: `{ key }`, `{ none:
 * true }` or `{ several: true }`. Text around the key (a copied snippet, a
 * line of a config file) is allowed; two different keys are refused, because
 * the wrong one would be saved.
 */
export function keyIn(text) {
  const found = new Set(String(text ?? "").match(KEY_IN_TEXT_RE) ?? []);
  if (found.size === 1) return { key: [...found][0] };
  return found.size === 0 ? { none: true } : { several: true };
}

/**
 * True when no browser on THIS computer is likely to see the sign-in: an SSH
 * session, or Linux with no display. The browser that the person uses is then
 * on another computer, and its redirect to 127.0.0.1 cannot reach this one.
 */
export function looksRemote(env, platform) {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return true;
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

const base64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function originOf(value) {
  try {
    const url = new URL(value);
    return url.origin === "null" ? null : url.origin;
  } catch {
    return null;
  }
}

/**
 * The authorization server metadata, held to the origin this sign-in is for:
 * the issuer IS that origin, and every endpoint is on it. A document that
 * names another host would send the person's approval, or a token, somewhere
 * else, so it is refused whole.
 */
export function checkMetadata(meta, origin) {
  if (!meta || typeof meta !== "object") return null;
  if (meta.issuer !== origin) return null;
  const out = { issuer: meta.issuer };
  for (const [field, key] of [
    ["authorization_endpoint", "authorize"],
    ["token_endpoint", "token"],
    ["registration_endpoint", "register"],
  ]) {
    if (typeof meta[field] !== "string" || originOf(meta[field]) !== origin) return null;
    out[key] = meta[field];
  }
  if (typeof meta.revocation_endpoint === "string" && originOf(meta.revocation_endpoint) === origin) {
    out.revoke = meta.revocation_endpoint;
  }
  const methods = meta.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) return null;
  // RFC 9207: a server that says it stamps `iss` on every answer must have
  // one on the answer this sign-in takes.
  out.issRequired = meta.authorization_response_iss_parameter_supported === true;
  return out;
}

async function getJson(fetchImpl, url, init = {}) {
  const res = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...init });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON.
  }
  return { status: res.status, ok: res.ok, body };
}

/** Who a bearer belongs to, by one read-scope call. `{ status, email }`; status 0 means no answer. */
async function whoAmI(ctx, origin, bearer) {
  try {
    const { status, body } = await getJson(ctx.fetch, new URL("/api/me", origin), {
      headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
    });
    const email = body && typeof body.email === "string" ? oneLine(body.email, 120) : null;
    const id = body && typeof body.id === "string" ? oneLine(body.id, 64) : null;
    return { status, who: email ?? id };
  } catch {
    return { status: 0, who: null };
  }
}

function connectedLine(who, origin, suffix = "") {
  return `${LINE_PREFIX} connected ${who ? `as ${who} ` : ""}on ${origin}${suffix}`;
}

function failed(ctx, reason) {
  ctx.print(`${LINE_PREFIX} connect failed: ${reason}`);
  return 1;
}

const PAGE_STYLE =
  "body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#1d1d1b;background:#fbfaf7}h1{font-size:1.25rem}";

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function page(res, status, heading, detail) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>PasserJack</title><style>${PAGE_STYLE}</style><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(detail)}</p>`,
  );
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function stateMatches(got, want) {
  const a = Buffer.from(String(got));
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The code exchange and the save, under the refresh lock, as ONE step. The
 * exchange of a same-client re-approval revokes the old refresh token on the
 * server at once (`issueConnection`), so a watcher that refreshed between the
 * exchange and the save would spend a dead token and say "expired". Under the
 * lock it waits, then reads the new file. Bounded: one request
 * (`REQUEST_TIMEOUT_MS`) and one write, under `LOCK_STALE_MS`.
 *
 * Answers `{ kind: "ok", cred, before }` (`before` is what the file held
 * just before the write), `{ kind: "exchange-failed", status }`, `{ kind:
 * "save-failed", cred }` or `{ kind: "busy" }` (no lock).
 */
async function exchangeAndSave(ctx, meta, file, { origin, code, redirectUri, clientId, verifier }) {
  try {
    return await withLock(file, async () => {
      const sentAt = Date.now();
      let tokens = null;
      let status = 0;
      try {
        const answer = await getJson(ctx.fetch, meta.token, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: verifier,
          }).toString(),
        });
        status = answer.status;
        tokens = answer.ok ? tokensFrom(answer.body, sentAt) : null;
      } catch {
        // No answer: reported by the caller.
      }
      if (!tokens) return { kind: "exchange-failed", status };
      const cred = {
        origin,
        kind: "oauth",
        clientId,
        ...tokens,
        connection: newConnectionId(),
        redirectUri,
        tokenEndpoint: meta.token,
        ...(meta.revoke ? { revocationEndpoint: meta.revoke } : {}),
      };
      const before = readCredentials(file);
      try {
        removeLeftoverTemps(file);
        writeCredentials(file, cred, ctx.platform);
      } catch {
        return { kind: "save-failed", cred };
      }
      return { kind: "ok", cred, before };
    });
  } catch {
    return { kind: "busy" };
  }
}

/**
 * End the credential that a new one just replaced, at its own endpoint. EVERY
 * overwrite does this, whatever the client or the account: a sign-in as
 * another account on the same client (the same port) would otherwise leave the
 * first account's connection live for 90 days with no file that holds it. For
 * the same account on the same client it is a harmless no-op:
 * `issueConnection` already revoked the old row and cleared both of its
 * hashes, so the old refresh token matches nothing. A revoke that the server
 * does not confirm prints one note.
 */
async function endPrevious(ctx, before, next) {
  if (before?.kind !== "oauth" || (next.kind === "oauth" && next.refreshToken === before.refreshToken)) return;
  const out = await revoke(ctx, before);
  if (!out.ok) {
    ctx.print(
      `${LINE_PREFIX} note: the previous sign-in on ${before.origin} was not ended (${out.status || "no answer"}). Disconnect it in Settings > Agents > Connected apps`,
    );
  }
}

/** The browser sign-in. */
async function signIn(ctx, origin, file) {
  let meta;
  try {
    const answer = await getJson(ctx.fetch, new URL(METADATA_PATH, origin), { headers: { accept: "application/json" } });
    meta = answer.ok ? checkMetadata(answer.body, origin) : null;
  } catch {
    return failed(ctx, `could not reach ${origin}. Check the network and try again`);
  }
  if (!meta) return failed(ctx, `${origin} did not describe a sign-in that this plugin can use`);

  // The callback port. The previous sign-in's port first: the server matches a
  // redirect address exactly and derives the client id from it, so the same
  // port is the same registered client, and a new port is a new one.
  const previous = readCredentials(file);
  const previousPort =
    previous?.kind === "oauth" && previous.origin === origin && previous.redirectUri
      ? Number(new URL(previous.redirectUri).port)
      : 0;
  const server = createServer();
  let port;
  try {
    port = previousPort ? await listen(server, previousPort).catch(() => listen(server, 0)) : await listen(server, 0);
  } catch {
    return failed(ctx, "could not open a port on 127.0.0.1 for the sign-in to come back to");
  }
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const close = () => {
    server.closeAllConnections?.();
    server.close();
  };

  try {
    let clientId;
    try {
      const reg = await getJson(ctx.fetch, meta.register, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_name: clientName(ctx.hostname),
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      });
      if (reg.status === 429) return failed(ctx, "PasserJack is busy. Wait a few minutes, then run /passerjack:connect again");
      if (!reg.ok || typeof reg.body?.client_id !== "string" || !reg.body.client_id) {
        const why = oneLine(reg.body?.error_description, 160);
        return failed(ctx, `the server refused to register this machine (${reg.status}${why ? `, ${why}` : ""})`);
      }
      clientId = reg.body.client_id;
    } catch {
      return failed(ctx, `could not reach ${origin}. Check the network and try again`);
    }

    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
    const state = base64url(crypto.randomBytes(24));
    const authorize = new URL(meta.authorize);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: CONNECT_SCOPE,
      state,
    }).toString();

    const outcome = await new Promise((resolve) => {
      let finished = false;
      const timer = setTimeout(() => {
        finished = true;
        resolve({ kind: "timeout" });
      }, ctx.timeoutMs);
      server.on("request", async (req, res) => {
        let url;
        try {
          url = new URL(req.url ?? "/", redirectUri);
        } catch {
          res.writeHead(400).end();
          return;
        }
        if (url.pathname !== "/callback" || req.method !== "GET") {
          res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
          return;
        }
        if (finished) {
          page(res, 410, "This sign-in is finished", "You can close this tab.");
          return;
        }
        const params = url.searchParams;
        // ONLY the flow that knows the state can answer it. Anything else (a
        // page that guessed the port, an old tab) is refused and the sign-in
        // keeps waiting for the real answer.
        if (!stateMatches(params.get("state") ?? "", state)) {
          page(
            res,
            400,
            "PasserJack did not connect",
            "This answer did not match the sign-in that Claude Code started. Close this tab and run /passerjack:connect again.",
          );
          return;
        }
        // RFC 9207: the answer names the server that gave it. A server that
        // advertises the parameter always sends it, so its absence is refused.
        const iss = params.get("iss");
        if (iss === null ? meta.issRequired : iss !== meta.issuer) {
          page(res, 400, "PasserJack did not connect", "This answer did not come from the PasserJack sign-in. Close this tab.");
          return;
        }
        finished = true;
        clearTimeout(timer);
        const error = params.get("error");
        const code = params.get("code");
        if (error || !code) {
          page(res, 200, "PasserJack did not connect", "The sign-in was not approved. You can close this tab.");
          resolve({ kind: "denied", error: oneLine(error, 40) ?? "no code" });
          return;
        }
        const result = await exchangeAndSave(ctx, meta, file, { origin, code, redirectUri, clientId, verifier });
        if (result.kind === "ok") {
          page(res, 200, "PasserJack is connected", "You can close this tab and go back to Claude Code.");
        } else {
          page(res, 502, "PasserJack did not connect", "The sign-in did not finish. Close this tab and run /passerjack:connect again.");
        }
        resolve(result);
      });

      ctx.print(`${LINE_PREFIX} a browser tab opens for the sign-in; if it does not, open this address: ${authorize.toString()}`);
      if (looksRemote(ctx.env, ctx.platform)) {
        ctx.print(
          `${LINE_PREFIX} this computer is remote or has no desktop. Open the address on any computer and press Connect. If the next page does not load, copy its full address (it starts with http://127.0.0.1:${port}/callback) and give it to Claude`,
        );
      }
      Promise.resolve()
        .then(() => ctx.openBrowser(authorize.toString()))
        .catch(() => {});
    });

    if (outcome.kind === "timeout") {
      const minutes = Math.max(1, Math.round(ctx.timeoutMs / 60_000));
      ctx.print(
        `${LINE_PREFIX} connect stopped: no sign-in after ${minutes} ${minutes === 1 ? "minute" : "minutes"}. Run /passerjack:connect again`,
      );
      return 1;
    }
    if (outcome.kind === "denied") return failed(ctx, `the sign-in was not approved (${outcome.error})`);
    if (outcome.kind === "exchange-failed") {
      return failed(ctx, `the server did not accept the sign-in code (${outcome.status || "no answer"})`);
    }
    if (outcome.kind === "busy") {
      return failed(ctx, "another PasserJack process held the sign-in file for too long. Run /passerjack:connect again");
    }
    if (outcome.kind === "save-failed") {
      // The server made a connection that no file holds: end it.
      await revoke(ctx, outcome.cred);
      return failed(ctx, `could not save the sign-in to ${file}`);
    }

    const { cred, before } = outcome;
    await endPrevious(ctx, before, cred);
    const { status, who } = await whoAmI(ctx, origin, cred.accessToken);
    if (status === 401 || status === 403) {
      return failed(ctx, `${origin} did not let the new sign-in read this account (${status}). Run /passerjack:connect again`);
    }
    if (status !== 200) {
      ctx.print(
        `${LINE_PREFIX} saved the sign-in on ${origin}, but could not check it (${status || "no answer"}). The watch starts when ${origin} answers`,
      );
      noteEnvKey(ctx);
      return 0;
    }
    ctx.print(connectedLine(who, origin));
    noteEnvKey(ctx);
    return 0;
  } finally {
    close();
  }
}

/**
 * `--relay <address>`: the address of the page after Connect, copied from a
 * browser on ANOTHER computer. That browser's redirect to 127.0.0.1 reached
 * its own computer, not this one, so the page did not load. This hands the
 * same address to the sign-in that waits on this computer. Only
 * `http://127.0.0.1:<port>/callback` is taken, so this is never a way to send
 * a request anywhere else.
 */
async function relay(ctx, address) {
  let url;
  try {
    url = new URL(address);
  } catch {
    url = null;
  }
  if (
    !url ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/callback" ||
    url.username ||
    url.password ||
    !url.searchParams.get("state")
  ) {
    return failed(ctx, "that is not the address of the page after Connect. It starts with http://127.0.0.1: and ends in /callback?code=...");
  }
  let status = 0;
  let text = "";
  try {
    const res = await ctx.fetch(url, { redirect: "error", signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
    status = res.status;
    text = await res.text().catch(() => "");
  } catch {
    return failed(ctx, "no sign-in waits at that address on this computer. Run /passerjack:connect, then give Claude the new address");
  }
  if (status === 200 && text.includes("PasserJack is connected")) {
    ctx.print(`${LINE_PREFIX} the sign-in reached the waiting /passerjack:connect`);
    return 0;
  }
  if (status === 410) return failed(ctx, "that sign-in is already finished. Run /passerjack:connect again for a new one");
  return failed(ctx, `the waiting sign-in did not take that address (${status || "no answer"})`);
}

/**
 * RFC 7009: ends the whole connection. Answers `{ ok, status }`: `ok` only for
 * a 2xx, the server's word that it took the request (RFC 7009 answers 200 for
 * any token it accepts to look at). A 429 (the `oauth-revoke` brake), a 5xx
 * or no answer (status 0) is NOT a revoke. Never throws.
 */
async function revoke(ctx, cred) {
  try {
    const res = await ctx.fetch(endpointOf(cred, "revoke"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: cred.refreshToken, token_type_hint: "refresh_token", client_id: cred.clientId }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

function noteEnvKey(ctx) {
  if ((ctx.env.PASSERJACK_API_KEY ?? "").trim()) {
    ctx.print(`${LINE_PREFIX} note: PASSERJACK_API_KEY is set in this environment, and the watcher uses it instead of the saved sign-in`);
  }
}

/** The text that `--paste` reads: the clipboard, or the file the person named. `{ text }` or `{ failed }`. */
async function pastedText(ctx, from) {
  if (!from) {
    const text = await ctx.readClipboard(ctx.platform);
    return text === null
      ? { failed: "could not read the clipboard. Copy the key in PasserJack, then run /passerjack:connect --paste again. Or put the key in a file and run /passerjack:connect --paste <file>" }
      : { text };
  }
  try {
    const stat = fs.statSync(from);
    if (!stat.isFile()) return { failed: `${from} is not a file` };
    if (stat.size > MAX_KEY_FILE_BYTES) return { failed: `${from} is larger than ${MAX_KEY_FILE_BYTES / 1024} KB, so it is not a key file` };
    return { text: fs.readFileSync(from, "utf8") };
  } catch {
    return { failed: `could not read ${from}` };
  }
}

/** `--paste [file]`: an API key from the clipboard or a file, checked, then saved. */
async function paste(ctx, origin, file, from) {
  const read = await pastedText(ctx, from);
  if (read.failed) return failed(ctx, read.failed);
  const found = keyIn(read.text);
  if (found.several) {
    return failed(ctx, `the ${from ? "file" : "clipboard"} holds more than one PasserJack API key. Copy only the one key, and try again`);
  }
  if (!found.key) {
    return failed(
      ctx,
      `the ${from ? "file does" : "clipboard does"} not hold a PasserJack API key (pj_ and 40 letters and digits). Make one in Settings > Agents, press Copy the key, and try again`,
    );
  }
  const key = found.key;
  const { status, who } = await whoAmI(ctx, origin, key);
  if (status === 401) return failed(ctx, "the key was refused. Make a new one in Settings > Agents");
  if (status === 403) return failed(ctx, "the key cannot read your board. Make one with View only in Settings > Agents");
  if (status !== 200) return failed(ctx, `could not check the key with ${origin} (${status || "no answer"}). Try again`);
  const cred = { origin, kind: "key", apiKey: key, connection: newConnectionId() };
  let before;
  try {
    before = await withLock(file, async () => {
      const held = readCredentials(file);
      removeLeftoverTemps(file);
      writeCredentials(file, cred, ctx.platform);
      return held;
    });
  } catch {
    return failed(ctx, `could not save the key to ${file}`);
  }
  await endPrevious(ctx, before, cred);
  ctx.print(
    connectedLine(
      who,
      origin,
      `. ${from ? `The key is saved: delete ${from} now` : "The key is saved: copy some other text now, so that the key is not on the clipboard"}`,
    ),
  );
  noteEnvKey(ctx);
  return 0;
}

/** A live check of the saved credential, refreshing it first when it is due. */
async function liveWho(ctx, file, cred) {
  let current = cred;
  const recover = async (staleToken) => {
    const out = await renewCredential(file, { staleToken, refresh: (c) => requestRefresh(c, ctx.fetch), retryMs: ctx.refusedRetryMs });
    return out.kind === "ok" ? out.cred : out.kind;
  };
  if (needsRefresh(current)) {
    const next = await recover(bearerOf(current));
    if (typeof next === "object") current = next;
    else if (next !== "transient") return { status: 401, who: null };
  }
  let answer = await whoAmI(ctx, cred.origin, bearerOf(current));
  if (answer.status === 401) {
    const next = await recover(bearerOf(current));
    if (typeof next !== "object") return answer;
    current = next;
    answer = await whoAmI(ctx, cred.origin, bearerOf(current));
  }
  return { ...answer, cred: current };
}

async function status(ctx, origin, file) {
  const cred = readCredentials(file);
  if (!cred) {
    ctx.print(`${LINE_PREFIX} not connected: run /passerjack:connect`);
    noteEnvKey(ctx);
    return 1;
  }
  if (cred.origin !== origin) {
    ctx.print(`${LINE_PREFIX} not connected on ${origin}: the saved sign-in is for ${cred.origin}. Run /passerjack:connect`);
    return 1;
  }
  const how = cred.kind === "oauth" ? " (browser sign-in)" : " (saved API key)";
  const live = await liveWho(ctx, file, cred);
  if (live.status === 200) {
    ctx.print(connectedLine(live.who, origin, how));
    noteEnvKey(ctx);
    return 0;
  }
  if (live.status === 401) {
    ctx.print(`${LINE_PREFIX} the saved sign-in on ${origin} no longer works: run /passerjack:connect`);
    return 1;
  }
  ctx.print(`${LINE_PREFIX} saved sign-in on ${origin}${how}, but ${origin} did not answer (${live.status || "no answer"})`);
  return 1;
}

/**
 * `--sign-out`. Under the lock, so a watcher cannot rotate the pair between
 * the read and the revoke: read the file again, revoke, delete. The file is
 * deleted ONLY when the server confirmed the revoke. Without the file the
 * refresh token that a revoke needs is gone, so a sign-out that deleted it
 * after a failed revoke would leave the 90-day connection live and tell the
 * person the opposite.
 */
async function signOut(ctx, origin, file) {
  let out;
  try {
    out = await withLock(file, async () => {
      const cred = readCredentials(file);
      if (!cred) {
        const removed = deleteCredentials(file);
        removeLeftoverTemps(file);
        return { kind: "none", removed };
      }
      if (cred.kind === "oauth") {
        const revoked = await revoke(ctx, cred);
        if (!revoked.ok) return { kind: "not-revoked", cred, status: revoked.status };
      }
      deleteCredentials(file);
      removeLeftoverTemps(file);
      return { kind: "done", cred };
    });
  } catch {
    return failed(ctx, "another PasserJack process held the sign-in file for too long. Run /passerjack:connect --sign-out again");
  }
  if (out.kind === "none") {
    ctx.print(`${LINE_PREFIX} not connected: nothing to sign out${out.removed ? " (an unreadable file was removed)" : ""}`);
    return 0;
  }
  if (out.kind === "not-revoked") {
    ctx.print(
      `${LINE_PREFIX} sign-out not finished: ${out.cred.origin} did not confirm it (${out.status || "no answer"}). The connection is still live. Run /passerjack:connect --sign-out again, or disconnect it in Settings > Agents > Connected apps`,
    );
    return 1;
  }
  ctx.print(
    out.cred.kind === "oauth"
      ? `${LINE_PREFIX} signed out on ${out.cred.origin}`
      : `${LINE_PREFIX} signed out on ${out.cred.origin}. The API key still works until you revoke it in Settings > Agents`,
  );
  return 0;
}

/**
 * The arguments to a mode, or null for anything else. A KEY typed as an
 * argument is its own answer: it is now in the conversation, so it is never
 * used, and the person is told to revoke it.
 */
export function parseArgs(argv) {
  const args = argv.flatMap((a) => String(a).split(/\s+/)).filter(Boolean);
  if (args.some((a) => keyIn(a).key || keyIn(a).several)) return { mode: "key-in-argument" };
  if (args.length === 0) return { mode: "sign-in" };
  const [first, ...rest] = args;
  if (rest.length === 0 && ["--paste", "--status", "--sign-out"].includes(first)) return { mode: first };
  // A path may hold spaces: the shell split it, so join it again.
  if (first === "--paste") return { mode: "--paste", from: rest.join(" ") };
  if (first === "--relay" && rest.length === 1) return { mode: "--relay", address: rest[0] };
  return null;
}

/**
 * The command. Answers the exit status: 0 done, 1 failed, 2 a bad argument.
 *
 * `deps.credentialsFile` is for tests in the same process, so that a test
 * never reads or writes the person's real file. The program never sets it:
 * it is not an argument and not an environment variable, so neither a prompt
 * nor a repository's settings can reach it. Without it the file is
 * `credentialsPath()`, which only the home folder decides.
 *
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, platform?: string, hostname?: string,
 *   print?: (line: string) => void, openBrowser?: (url: string) => unknown,
 *   readClipboard?: (platform: string) => Promise<string | null>, fetch?: typeof fetch, timeoutMs?: number,
 *   credentialsFile?: string, refusedRetryMs?: number }} [deps]
 */
export async function run(argv, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const ctx = {
    env,
    platform,
    hostname: deps.hostname ?? os.hostname(),
    print: deps.print ?? ((line) => process.stdout.write(`${line}\n`)),
    openBrowser: deps.openBrowser ?? defaultOpenBrowser(platform, env),
    readClipboard: deps.readClipboard ?? ((p) => readClipboard(p, execTextFor(p, env), env)),
    fetch: deps.fetch ?? fetch,
    timeoutMs: deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
    refusedRetryMs: deps.refusedRetryMs,
  };
  const parsed = parseArgs(argv);
  if (!parsed) {
    ctx.print(USAGE);
    return 2;
  }
  if (parsed.mode === "key-in-argument") {
    ctx.print(
      `${LINE_PREFIX} connect failed: a key was typed after the command, so it is now in this conversation. Revoke that key in Settings > Agents, make a new one, and save it with /passerjack:connect --paste`,
    );
    return 2;
  }
  // The relay talks to this computer only, so it needs no origin.
  if (parsed.mode === "--relay") return relay(ctx, parsed.address);
  let origin;
  try {
    const url = new URL(String(ctx.env.PASSERJACK_ORIGIN ?? "").trim() || "https://passerjack.com");
    if (!originAllowed(url)) {
      ctx.print(`${LINE_PREFIX} connect failed: PASSERJACK_ORIGIN may only be https://passerjack.com or a localhost address`);
      return 1;
    }
    origin = url.origin;
  } catch {
    ctx.print(`${LINE_PREFIX} connect failed: PASSERJACK_ORIGIN is not an address`);
    return 1;
  }
  const file = deps.credentialsFile ?? credentialsPath();
  if (parsed.mode === "--status") return status(ctx, origin, file);
  if (parsed.mode === "--sign-out") return signOut(ctx, origin, file);
  if (parsed.mode === "--paste") return paste(ctx, origin, file, parsed.from);
  return signIn(ctx, origin, file);
}

/**
 * Run as a program, not when a test imports it. Both sides are REAL paths: a
 * plugin root reached through a symlink (a dotfiles-managed `~/.claude`, or
 * macOS's `/tmp`) gives `argv[1]` the link and `import.meta.url` the target,
 * and a plain compare then skips the command and exits 0 with no line.
 */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      // Only a bug reaches here. Its class and nothing more: a message is free text.
      process.stdout.write(`${LINE_PREFIX} connect failed: unexpected ${err instanceof Error ? err.name : "error"}\n`);
      process.exitCode = 1;
    },
  );
}
