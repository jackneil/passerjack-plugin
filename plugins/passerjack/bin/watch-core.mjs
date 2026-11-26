/**
 * The pure half of the PasserJack watcher: configuration, the SSE frame parser,
 * the words every printed line uses, the reconnect delays, the outage memo, and
 * what a session registration sends (see PRESENCE below). `watch.mjs` is the
 * half with sockets, timers and `git` in it.
 *
 * DEPENDENCY-FREE ON PURPOSE. This file ships inside a Claude Code plugin and
 * runs on whatever Node the user has, so it imports nothing, not even from the
 * app it talks to. The few sentences it prints are therefore COPIES of the
 * server's lines-mode wording (`src/lib/item-feed.ts`, `src/lib/message-feed.ts`),
 * and `tests/unit/passerjack-plugin.test.ts` compares the two so they cannot
 * drift: a session reading a doorbell must see the same line whether it came
 * from the curl recipe or from this plugin.
 *
 * EVERY LINE WAKES A SESSION. A Claude Code monitor turns each stdout line into
 * a notification, and a notification costs a turn. So this prints one line per
 * doorbell, per message and per catch-up, one registration line per process,
 * and otherwise almost nothing: not the watching line (it would ring on every
 * fourteen-minute reconnect), not the quiet re-registration before each
 * reconnect, not a failed registration, not a transient network error, never
 * a body.
 */

/** Every line starts with this, the server's own `LINE_PREFIX`. */
export const LINE_PREFIX = "[passerjack]";

export const DEFAULT_ORIGIN = "https://passerjack.com";
export const DEFAULT_TAG = "claude";

/** The server's `MAX_DOORBELL_NAME_CHARS`, and `oneLine`'s default cap. */
export const MAX_NAME_CHARS = 80;

/** The server's `LINES_BURST_WINDOW_MS`: see `BurstWindow`. */
export const BURST_WINDOW_MS = 1500;

/** Reconnect delays after a failure: 1 s doubling to a minute, jittered. */
export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 60_000;

/** What a 429 (too many watchers open on the account) waits before asking again. */
export const TOO_MANY_WATCHERS_WAIT_MS = 60_000;

/**
 * Silence after which a connection is presumed dead. The server writes a
 * `: ping` every 25 seconds, so three missed pings is a socket that died
 * without closing (a laptop lid, a Wi-Fi hop), which never errors on its own.
 */
export const IDLE_TIMEOUT_MS = 90_000;

/** Continuous failure before the one `watch offline` line. */
export const OFFLINE_AFTER_MS = 10 * 60_000;

/**
 * A connection that ends cleanly sooner than this is treated as a failure and
 * backs off, rather than being reconnected at once. The server's own ending is
 * at fourteen minutes; a stream that opens and closes in seconds, over and
 * over, is something refusing us, and reconnecting immediately would hammer it.
 */
export const MIN_HEALTHY_LIFETIME_MS = 5000;

/** The longest server-sent reconnect hint honoured (its drain sends 1 to 3 s). */
export const MAX_RETRY_HINT_MS = 10_000;

const MESSAGE_NAME_RE = /^[a-z0-9._-]{1,32}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The origin from `PASSERJACK_ORIGIN`, or the default. Answers
 * `{ ok: true, origin }` or `{ ok: false, line }`.
 *
 * PINNED: a key or a token goes to PasserJack itself or to this machine, and
 * nowhere else. The monitor inherits the session's environment, which includes
 * a project's checked-in settings `env` block, so an unpinned origin would let
 * any repository you open point your key at its own server, silently. The
 * sign-in (`connect.mjs`) refuses any other origin, and the credentials file
 * is held to the same pin when it is READ: `parseCredential` drops a
 * credential whose `origin` fails `originAllowed`, so no refresh or revoke is
 * ever sent to an origin that a file names. For the same reason no variable
 * chooses where that file lives (`credentialsPath`): only the home folder does.
 */
export function resolveOrigin(env) {
  try {
    const url = new URL((env.PASSERJACK_ORIGIN ?? "").trim() || DEFAULT_ORIGIN);
    if (!originAllowed(url)) {
      return {
        ok: false,
        line: `${LINE_PREFIX} watch not started: PASSERJACK_ORIGIN may only be ${DEFAULT_ORIGIN} or a localhost address`,
      };
    }
    return { ok: true, origin: url.origin };
  } catch {
    return { ok: false, line: `${LINE_PREFIX} watch not started: PASSERJACK_ORIGIN is not an address` };
  }
}

/** The pin itself: the hosted origin over https, or a localhost address over http or https. */
export function originAllowed(url) {
  const local = LOCAL_HOSTS.has(url.hostname);
  const hosted = url.protocol === "https:" && url.origin === DEFAULT_ORIGIN;
  return hosted || (local && (url.protocol === "https:" || url.protocol === "http:"));
}

/**
 * The watcher's configuration from the environment. The key is OPTIONAL: when
 * `PASSERJACK_API_KEY` is unset, `key` is null and the watcher reads the
 * credentials file that `/passerjack:connect` writes (`credentials.mjs`),
 * waiting for it if it is not there yet. A set variable always wins over the
 * file. (A monitor cannot be handed plugin user settings, and a key on a
 * command line is a key in every process listing.)
 *
 * Answers `{ ok: true, key, origin, lanes }` or `{ ok: false, line }`, where
 * `line` is the ONE line to print before exiting 0. Exit 0 and not 1: the
 * monitor has done what it can, and a failure status would only add noise to
 * the session.
 */
export function readConfig(env) {
  const key = (env.PASSERJACK_API_KEY ?? "").trim() || null;
  const resolved = resolveOrigin(env);
  if (!resolved.ok) return resolved;
  const origin = resolved.origin;
  // Unset means the default; set to nothing means "no item lane".
  const tag = env.PASSERJACK_WATCH_TAG === undefined ? DEFAULT_TAG : env.PASSERJACK_WATCH_TAG.trim();
  const rawName = (env.PASSERJACK_WATCH_NAME ?? "").trim().toLowerCase();
  if (rawName && !MESSAGE_NAME_RE.test(rawName)) {
    return {
      ok: false,
      line: `${LINE_PREFIX} watch not started: PASSERJACK_WATCH_NAME is 1 to 32 characters of a-z, 0-9, dot, dash and underscore`,
    };
  }
  const lanes = [];
  if (tag) lanes.push({ kind: "items", tag });
  // ALWAYS a message lane. With a name it is that mailbox plus what hinted
  // sends deliver to this session; without one it is the session alone, which
  // is still how a hinted send that picked this session reaches it.
  lanes.push({ kind: "messages", to: rawName || null });
  return { ok: true, key, origin, lanes };
}

/**
 * The SSE address for one lane. SSE and not `format=lines`: the frames carry a
 * cursor (`id:`) this process keeps, so a reconnect resumes by header rather
 * than by a person reading a seq off a line. `source=human` on the item lane is
 * the curl recipe's choice for the curl recipe's reason: the items the agent
 * files back under the same tag must not wake it.
 *
 * @param {string} origin
 * @param {{ kind: string, tag?: string, to?: string | null }} lane
 * @param {string | null} [sessionId]
 */
export function feedUrl(origin, lane, sessionId = null) {
  const url = new URL("/api/stream", origin);
  if (lane.kind === "items") {
    url.searchParams.set("feed", "items");
    url.searchParams.set("tag", lane.tag);
    url.searchParams.set("source", "human");
  } else {
    url.searchParams.set("feed", "messages");
    // A nameless lane is a session-only watch: `session=` below is the whole ask.
    if (lane.to) url.searchParams.set("to", lane.to);
  }
  // The feed is what keeps a registered session present: the server heartbeats
  // the row off this connection's keepalive and marks it disconnected on close.
  if (sessionId) url.searchParams.set("session", sessionId);
  return url.toString();
}

/**
 * PRESENCE. The watcher registers this session with the server
 * (`POST /api/sessions`) so other agents on the account can see where it is
 * working. Everything below decides WHAT is sent, and it is the whole reason
 * this half exists: every fact is reduced here, before it leaves the machine,
 * to the short form the server stores. A full path never leaves (only the
 * working directory's last segment does), a remote URL never leaves (only its
 * `owner/name`), and the key is never in the body at all.
 */

/** The harness this plugin reports: it only ever runs under Claude Code. */
export const HARNESS = "claude-code";

/** The server's field caps (`src/lib/agent-session-rules.ts`). */
export const MAX_HOST_CHARS = 64;
export const MAX_CWD_CHARS = 64;
export const MAX_REPO_CHARS = 100;
export const MAX_BRANCH_CHARS = 100;

const SLUG_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const REMOTE_SCHEMES = new Set(["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One path segment worth reporting as a repo owner or name: never `.` or `..`. */
function slugSegment(value) {
  return SLUG_SEGMENT_RE.test(value) && !/^\.+$/.test(value) ? value : null;
}

/**
 * A git remote reduced to `owner/name`, or null. Accepts the shapes git itself
 * does for a hosted repository: `https://host/owner/name(.git)` (with or
 * without `user:token@`, which is DROPPED, never parsed into anything kept),
 * `ssh://git@host[:port]/owner/name(.git)`, and the scp form
 * `[user@]host:owner/name(.git)`. Only the last two path segments are used,
 * each must be plain slug characters, and anything else (a local path, a
 * `file://` remote, a drive letter, percent-encoding, more than 100
 * characters) is null. It never answers a URL, a host or a credential.
 *
 * @param {unknown} remote
 * @returns {string | null}
 */
export function repoSlugFromRemote(remote) {
  if (typeof remote !== "string") return null;
  const text = remote.trim();
  if (!text || /\s/.test(text)) return null;
  let path;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (!REMOTE_SCHEMES.has(url.protocol) || !url.hostname) return null;
    path = url.pathname;
  } else {
    // scp form. A one-letter "host" is a Windows drive (`C:/src/repo`), which
    // git reads as a local path, and so do we.
    const scp = text.match(/^(?:[^@/\\:]+@)?([^@/\\:]{2,}):(.+)$/);
    if (!scp) return null;
    path = scp[2];
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const owner = slugSegment(segments[segments.length - 2]);
  const name = slugSegment(segments[segments.length - 1].replace(/\.git$/i, ""));
  if (!owner || !name) return null;
  const slug = `${owner}/${name}`;
  return slug.length > MAX_REPO_CHARS ? null : slug;
}

/** The last segment of a path in either separator, so a full path cannot leave. */
export function lastSegment(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/** One line of text cut to `max` code points: what the server's CHECKs allow. */
function clip(value, max) {
  const text = oneLine(value, Number.MAX_SAFE_INTEGER);
  if (!text) return null;
  return Array.from(text).slice(0, max).join("").trimEnd() || null;
}

/**
 * The `POST /api/sessions` body. `facts` is what the watcher gathered
 * (`hostname`, the full `cwd`, the raw `remote` URL, the `branch`, a
 * process-lifetime `clientId`), and this is where each is reduced: the name
 * only when it is a valid message name, the directory to its last segment,
 * the remote to its slug, a detached `HEAD` to nothing. Absent fields are
 * left out rather than sent as null.
 *
 * @typedef {{ host: string, harness: string, name?: string, repo?: string, cwd?: string, branch?: string, clientId?: string, waits?: boolean }} SessionBody
 * @param {Record<string, string | undefined> | undefined} env
 * @param {{ hostname?: unknown, cwd?: unknown, remote?: unknown, branch?: unknown, clientId?: unknown } | undefined} facts
 * @returns {SessionBody}
 */
export function sessionBody(env, facts) {
  const f = facts ?? {};
  /** @type {SessionBody} */
  const body = { host: clip(f.hostname, MAX_HOST_CHARS) ?? "unknown", harness: HARNESS };
  const name = (env?.PASSERJACK_WATCH_NAME ?? "").trim().toLowerCase();
  if (MESSAGE_NAME_RE.test(name)) body.name = name;
  const repo = repoSlugFromRemote(f.remote);
  if (repo) body.repo = repo;
  const cwd = clip(lastSegment(f.cwd), MAX_CWD_CHARS);
  if (cwd) body.cwd = cwd;
  const branch = f.branch === "HEAD" ? null : clip(f.branch, MAX_BRANCH_CHARS);
  if (branch) body.branch = branch;
  if (typeof f.clientId === "string" && UUID_RE.test(f.clientId)) body.clientId = f.clientId;
  // The plugin's hooks report this session's turn ends (`hooks/hooks.json`),
  // so the server pushes an open question only after the minute of silence.
  // Only when the hooks can find this watcher's session (`CLAUDE_PID`, the
  // link key): without it they post nothing, and a session that said it
  // waits would never push a question at all.
  if (claudeKey(env)) body.waits = true;
  return body;
}

/**
 * The Claude Code process id this process runs under (`CLAUDE_PID`), or null
 * when the environment does not say. It is the key that links the watcher to
 * the plugin's hooks of the same session (`session-link.mjs`): a monitor and a
 * hook of one Claude Code process both carry it, with the same value, and a
 * `/clear` does not change it.
 */
export function claudeKey(env) {
  const raw = String(env?.CLAUDE_PID ?? "").trim();
  return /^[1-9][0-9]{0,9}$/.test(raw) ? raw : null;
}

/** The session id out of a registration answer, or null for anything not shaped like one. */
export function sessionIdFrom(answer) {
  const id = answer && typeof answer === "object" ? answer.id : null;
  return typeof id === "string" && UUID_RE.test(id) ? id.toLowerCase() : null;
}

/**
 * The ONE line printed when this session registers, so the agent knows it is
 * listed and under which id (`list_sessions` has the full id; `set_status`
 * takes it). Re-reduces every field itself rather than trusting its caller:
 * the directory to its last segment, the repo to a slug, so no full path,
 * remote URL or key can reach a line that lands in the session's context.
 *
 * @param {{ host?: unknown, cwd?: unknown, repo?: unknown, id: unknown }} session
 */
export function registeredLine({ host, cwd, repo, id }) {
  const where = oneLine(host, MAX_HOST_CHARS) ?? "unknown";
  const dir = oneLine(lastSegment(cwd), MAX_CWD_CHARS);
  const slug = typeof repo === "string" && repo.length <= MAX_REPO_CHARS && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo) ? repo : null;
  return `${LINE_PREFIX} registered as ${where}${dir ? `/${dir}` : ""} (${slug ?? "no repo"}) session ${shortId(id)}`;
}

/**
 * A server-sent events parser, per the HTML spec's interpretation rules, fed
 * text as it arrives. `push` answers what the text completed, in order:
 * `{ type: "event", event, data }` for a dispatched frame and
 * `{ type: "retry", ms }` for a reconnect hint.
 *
 * `lastEventId` follows the spec exactly, including the case the server's
 * goodbye relies on: a block holding only `id: <seq>` moves the cursor at the
 * blank line without dispatching anything.
 */
export class SseParser {
  constructor(lastEventId = "") {
    this.lastEventId = lastEventId;
    this.buffer = "";
    this.idBuffer = lastEventId;
    this.data = "";
    this.eventType = "";
  }

  push(text) {
    this.buffer += text;
    const out = [];
    for (;;) {
      const at = this.buffer.search(/[\r\n]/);
      if (at === -1) break;
      let width = 1;
      if (this.buffer[at] === "\r") {
        // A CR at the very end may be the first half of a CRLF split across
        // two chunks: leave it until the next chunk says which.
        if (at === this.buffer.length - 1) break;
        if (this.buffer[at + 1] === "\n") width = 2;
      }
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + width);
      this.line(line, out);
    }
    return out;
  }

  line(line, out) {
    if (line === "") {
      this.lastEventId = this.idBuffer;
      if (this.data !== "") {
        out.push({ type: "event", event: this.eventType || "message", data: this.data.slice(0, -1) });
      }
      this.data = "";
      this.eventType = "";
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data += `${value}\n`;
    else if (field === "event") this.eventType = value;
    else if (field === "id" && !value.includes("\0")) this.idBuffer = value;
    else if (field === "retry" && /^\d+$/.test(value)) out.push({ type: "retry", ms: Number(value) });
  }
}

/** The cursor worth sending back as `Last-Event-ID`: digits, or nothing. */
export function resumeHeader(lastEventId) {
  return /^\d+$/.test(lastEventId) ? lastEventId : null;
}

/**
 * The server's `oneLine`, copied: text from a person or an agent, made safe to
 * print on ONE line. Re-applied here to everything the server sent, because the
 * server is the only thing that sanitised it before and this line is about to
 * wake a session: a newline in a title would be a second, forged notification.
 */
function breaksLine(code) {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}
const INVISIBLE = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

export function oneLine(value, max = MAX_NAME_CHARS) {
  const text = typeof value === "string" ? value : "";
  const flat = Array.from(text, (ch) => (breaksLine(ch.codePointAt(0) ?? 0) ? " " : ch)).join("");
  const clean = flat.replace(/\s+/g, " ").replace(INVISIBLE, "").trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 3).trimEnd()}...` : clean;
}

/** An id's first eight characters, and only characters an id can hold. */
function shortId(value) {
  return (typeof value === "string" ? value : "").replace(/[^0-9A-Za-z-]/g, "").slice(0, 8) || "unknown";
}

function count(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The server's `humanBytes`. */
export function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const quoted = (text) => `"${text.replace(/"/g, "'")}"`;

/** The server's `doorbellLine`, over a doorbell frame's JSON. */
export function doorbellLine(bell) {
  const b = bell ?? {};
  const size = count(b.sizeBytes);
  const sizeText = size === null ? "" : ` (${humanBytes(size)})`;
  const kind = oneLine(b.kind, 24) ?? "item";
  const name = (oneLine(b.name) ?? "untitled").replace(/"/g, "'");
  const tag = oneLine(b.tag, 64) ?? "?";
  const sender = oneLine(b.sender, 60) ?? "an unnamed device";
  return `${LINE_PREFIX} new ${kind} "${name}"${sizeText} tagged ${tag}, from ${sender}, item ${shortId(b.itemId)}`;
}

/** The server's `OWNER_TARGET_NAME` (`src/lib/agent-conversation-rules.ts`): the `to` of an owner message from the Agents page. */
export const OWNER_TARGET_NAME = "@session";

/**
 * Who an OWNER message is for, by session id, never by the shared name
 * `@session`: two terminals in one folder, or a model that lost its session
 * id to a compaction, must not act on (and ack) words typed for another
 * session. The frame's `targetSessionId` (a newer server sends it) names the
 * session; when it is this watcher's own, or when the frame has none (an
 * older server, which rings an owner message on its target session's watch
 * only), it is THIS session.
 */
function ownerAudience(target, ownSessionId) {
  const own = typeof ownSessionId === "string" && UUID_RE.test(ownSessionId) ? ownSessionId.toLowerCase() : null;
  const named = typeof target === "string" && UUID_RE.test(target) ? target.toLowerCase() : null;
  if (named && named !== own) return `for session ${shortId(named)}`;
  if (own) return `for this session ${shortId(own)}`;
  return `for ${quoted(OWNER_TARGET_NAME)}`;
}

/**
 * The server's `messageBellLine`, over an agent-message frame's JSON. An
 * owner message names its session instead (`ownerAudience`): `ownSessionId`
 * is the session this watch carries.
 *
 * @param {any} bell
 * @param {string | null} [ownSessionId]
 */
export function messageBellLine(bell, ownSessionId = null) {
  const b = bell ?? {};
  const subject = oneLine(b.subject);
  const subjectText = subject ? `, subject ${quoted(subject)}` : "";
  const to = oneLine(b.to, 32) ?? "?";
  const from = oneLine(b.from, 120) ?? "somebody";
  const audience = to === OWNER_TARGET_NAME ? ownerAudience(b.targetSessionId, ownSessionId) : `for ${quoted(to)}`;
  return `${LINE_PREFIX} message ${shortId(b.messageId)} ${audience} from ${quoted(from)}${subjectText}`;
}

/** The server's `catchupLine`. */
export function catchupLine(n, tag, since) {
  return `${LINE_PREFIX} ${n} ${n === 1 ? "item" : "items"} tagged ${tag} changed since seq ${since}`;
}

/**
 * Who a message lane is for, in the server's `watchedPhrase` words: a name, or
 * (a null `to`, the nameless lane) this session. This plugin never watches a thread.
 */
function messageAudience(to) {
  return to ? `for ${quoted(to)}` : "for this session";
}

/**
 * The server's `allPassedLine`, over an all-passed frame's JSON: every session a
 * message this session SENT reached has passed it. Counts and an id, nothing
 * anybody typed.
 */
export function allPassedLine(bell) {
  const b = bell ?? {};
  const passed = count(b.passed) ?? 0;
  const reached = count(b.reached) ?? 0;
  return `${LINE_PREFIX} message ${shortId(b.messageId)} was passed by every session it reached (${passed} of ${reached})`;
}

/** The server's `messageCatchupLine`, for a watch on a name or on this session alone. */
export function messageCatchupLine(n, to, since) {
  const noun = n === 1 ? "message" : "messages";
  return `${LINE_PREFIX} ${n} ${noun} ${messageAudience(to)} arrived since seq ${since}; read them with check_messages`;
}

/** The server's `burstLine`. */
export function burstLine(n, tag) {
  return `${LINE_PREFIX} ${n} more items tagged ${tag} arrived together; list them with list_items`;
}

/** The server's `messageBurstLine`, for a watch on a name or on this session alone. */
export function messageBurstLine(n, to) {
  return `${LINE_PREFIX} ${n} more messages ${messageAudience(to)} arrived together; read them with check_messages`;
}

/**
 * What one dispatched frame prints, or null for a frame that prints nothing
 * (`watching`, anything unknown, anything unparseable). `ring` is a doorbell
 * or a message, which goes through the burst window; `catchup` prints at once,
 * as it does on the server. `sessionId` is the session the feed carries, which
 * an owner message's line names.
 *
 * @param {any} lane
 * @param {any} frame
 * @param {string | null} [sessionId]
 */
export function lineForFrame(lane, frame, sessionId = null) {
  let data;
  try {
    data = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  if (lane.kind === "items" && frame.event === "doorbell") {
    return { kind: "ring", line: doorbellLine(data) };
  }
  if (lane.kind === "messages" && frame.event === "agent-message") {
    return { kind: "ring", line: messageBellLine(data, sessionId) };
  }
  if (lane.kind === "messages" && frame.event === "all-passed") {
    return { kind: "ring", line: allPassedLine(data) };
  }
  if (frame.event === "catchup") {
    const n = count(data.count);
    const since = count(data.since);
    if (!n || since === null) return null;
    if (lane.kind === "items") {
      return { kind: "catchup", line: catchupLine(n, oneLine(data.tag, 64) ?? lane.tag, since) };
    }
    return { kind: "catchup", line: messageCatchupLine(n, lane.to, since) };
  }
  return null;
}

/** The burst line for a lane. */
export function burstLineFor(lane, n) {
  return lane.kind === "items" ? burstLine(n, lane.tag) : messageBurstLine(n, lane.to);
}

/**
 * The server's lines-mode burst window, kept here because this process is the
 * one printing lines now and the server's SSE mode collapses nothing. One act
 * can make hundreds of items match at once (a tag renamed onto the watched
 * one), and each line is a turn. The first ring prints at once and opens a
 * window; rings inside it are held and, when it closes, print as their own
 * line if alone or as ONE burst line if not. A window that flushed stays open
 * for one more.
 *
 * Time is injected (`schedule(fn, ms)`) so it can be driven without real timers.
 */
export class BurstWindow {
  constructor(print, burstOf, schedule, windowMs = BURST_WINDOW_MS) {
    this.print = print;
    this.burstOf = burstOf;
    this.schedule = schedule;
    this.windowMs = windowMs;
    this.open = false;
    this.first = null;
    this.held = 0;
  }

  ring(line) {
    if (this.open) {
      this.first ??= line;
      this.held += 1;
      return;
    }
    this.print(line);
    this.arm();
  }

  arm() {
    this.open = true;
    this.schedule(() => this.close(), this.windowMs);
  }

  close() {
    this.open = false;
    if (this.first === null) return;
    this.print(this.held === 1 ? this.first : this.burstOf(this.held));
    this.first = null;
    this.held = 0;
    this.arm();
  }
}

/** The delay before retry number `attempt` (0-based) after a failure. */
export function backoffMs(attempt, random = Math.random) {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(attempt, 16));
  return Math.round(base / 2 + (random() * base) / 2);
}

/**
 * The one `watch offline` line and the one `back online` line, across every
 * lane at once: one network outage takes both lanes down together, and two
 * lines saying so would be two turns for one fact.
 */
export class OutageMemo {
  constructor(thresholdMs = OFFLINE_AFTER_MS) {
    this.thresholdMs = thresholdMs;
    this.failingSince = new Map();
    this.announced = false;
  }

  /** A lane failed at `now`. Answers the offline line the first time failure has lasted long enough. */
  failed(lane, now) {
    if (!this.failingSince.has(lane)) this.failingSince.set(lane, now);
    if (this.announced) return null;
    const since = Math.min(...this.failingSince.values());
    if (now - since < this.thresholdMs) return null;
    this.announced = true;
    const at = new Date(since).toISOString().replace(/\.\d{3}Z$/, "Z");
    return `${LINE_PREFIX} watch offline since ${at}, still retrying`;
  }

  /**
   * A lane reached the server and was told to wait (the 429 watcher cap). Not
   * an outage, so it prints nothing, and it takes the lane out of the failing
   * set so a cap on one lane cannot hold an offline claim open for the other.
   */
  answered(lane) {
    this.failingSince.delete(lane);
  }

  /** A lane connected. Answers the back-online line once every lane is back after an announced outage. */
  recovered(lane) {
    this.failingSince.delete(lane);
    if (!this.announced || this.failingSince.size > 0) return null;
    this.announced = false;
    return `${LINE_PREFIX} watch back online`;
  }
}

/**
 * WHEN THE `registered` LINE IS PRINTED AGAIN (dcr wave 1 P8). The line gives
 * the agent this session's id, which a compaction can take from its context.
 * But every line the watcher prints is a notification that wakes the session,
 * and the watcher reconnects about every fourteen minutes on the server's
 * goodbye. So: `new-id` (a new row) always; `back-online` (after an outage
 * that the watcher announced) yes, beside the back-online line that wakes the
 * session anyway; `reconnect` (the routine re-arm) never. An owner message's
 * own line carries the session id (`messageBellLine`), so the agent never
 * needs this line to answer one.
 *
 * @param {"new-id" | "back-online" | "reconnect"} reason
 */
export function reprintsRegistered(reason) {
  return reason === "new-id" || reason === "back-online";
}

/** The line a 401 prints before the watcher exits, for a key from `PASSERJACK_API_KEY`. */
export const KEY_REFUSED_LINE = `${LINE_PREFIX} watch stopped: the API key was refused`;

/**
 * The ONE line printed when there is no key in the environment and no usable
 * sign-in in the credentials file. The watcher then checks the file every few
 * seconds and starts on its own when `/passerjack:connect` writes it.
 */
export const WAITING_FOR_SIGN_IN_LINE = `${LINE_PREFIX} watch waiting for sign-in: run /passerjack:connect`;

/** A browser sign-in whose refresh the server refused (revoked, expired, replaced). The watcher waits again. */
export const SIGN_IN_EXPIRED_LINE = `${LINE_PREFIX} watch stopped: sign-in expired, run /passerjack:connect`;

/** A key saved by `/passerjack:connect --paste` that the server refused. The watcher waits again. */
export const SAVED_KEY_REFUSED_LINE = `${LINE_PREFIX} watch stopped: the saved API key was refused, run /passerjack:connect`;

/**
 * The ONE line a nameless message lane prints when it cannot get a session:
 * that lane IS its session, so without one nothing sent by hints can reach it.
 * Once per process; the lane keeps retrying in silence after it.
 */
export const NO_SESSION_LINE = `${LINE_PREFIX} watch has no session, so messages sent by hints will not reach it`;

/**
 * The line a lane prints when the server refuses its request for a reason
 * asking again will not fix (a 400, 403 or 404): the server's own sentence,
 * made one line.
 */
export function laneStoppedLine(status, body) {
  let reason = null;
  try {
    const parsed = JSON.parse(body);
    reason = oneLine(parsed && typeof parsed.error === "string" ? parsed.error : null, 200);
  } catch {
    // Not JSON: the status alone says it.
  }
  return `${LINE_PREFIX} watch stopped: the server refused it (${status}${reason ? `, ${reason}` : ""})`;
}
