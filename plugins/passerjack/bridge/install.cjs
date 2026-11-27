/**
 * THE PASSERJACK BRIDGE SETUP SCRIPT: installs the agent bridge and adds its
 * hooks to ONE harness's user settings, with the same contract as the MCP
 * setup script (`src/lib/setup-config-script.ts`): check, add, verify and
 * restore, and only FIXED WORDS on stdout. It never prints a line of a
 * settings file, an error message or a stack: a settings file can hold the
 * keys of other servers.
 *
 *   node passerjack-bridge.cjs check   <harness>
 *   node passerjack-bridge.cjs add     <harness>
 *   node passerjack-bridge.cjs verify  <harness> [<backup>]
 *   node passerjack-bridge.cjs restore <harness> [<backup>]
 *
 * The server serves this file at `/setup/<slug>/passerjack-bridge.cjs` with
 * one line in front of it, `const EMBED = {...}`: the origin, and the bridge's
 * files byte for byte (`src/lib/agent-bridge-script.ts`). The bridge goes to
 * the PasserJack folder (`~/.config/passerjack/agent-bridge`, beside the
 * credentials file), in the plugin's own layout (`bin/` and `bridge/`), so its
 * imports resolve as they do in the plugin.
 *
 * MERGED, NEVER CLOBBERED. A JSON settings file is parsed strictly; one that
 * does not parse (a comment, a trailing comma) is refused and nothing
 * changes, so the user adds the hooks by hand. The PasserJack entries are
 * appended to each event's list, and every other entry, key and value stays
 * (the file is written back with its own indent). A file of PasserJack's own
 * (Grok Build's `~/.grok/hooks/passerjack.json`, a plugin file) is written
 * whole. Every write goes to a temporary file beside the target and is
 * renamed over it in one step; the backup is a 0600 copy beside the file.
 */

"use strict";

/* global EMBED */
// A CommonJS script that the user's own Node runs as one downloaded file: require is its import.
/* eslint-disable @typescript-eslint/no-require-imports */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const say = (line) => process.stdout.write(`${line}\n`);
const WIN = process.platform === "win32";
const HOME = os.homedir();
const p = (...parts) => path.join(HOME, ...parts);

/**
 * The PasserJack folder of a home folder: where the bridge lives (beside the
 * credentials file) and the credentials file itself. A copy of
 * `credentialsPath` in `bin/credentials.mjs`, which this one downloaded file
 * cannot import; `tests/unit/agent-bridge-setup.test.ts` pins the two
 * together on Windows and on POSIX.
 */
function placesFor(home, platform) {
  const win = platform === "win32";
  const join = win ? path.win32.join : path.posix.join;
  const base = win ? join(home, "AppData", "Local", "PasserJack") : join(home, ".config", "passerjack");
  return { root: join(base, "agent-bridge"), credentials: join(base, "credentials.json") };
}

/** Where the bridge lives: the PasserJack folder, beside the credentials file. */
const ROOT = placesFor(HOME, process.platform).root;
const CREDENTIALS = placesFor(HOME, process.platform).credentials;
const BRIDGE = path.join(ROOT, "bridge", "bridge.mjs");
const NODE = process.execPath;
/** Every PasserJack entry names this, and nothing else does. */
const MARK = path.join("agent-bridge", "bridge", "bridge.mjs");

/** `DEFAULT_ORIGIN` of `bin/watch-core.mjs`, pinned by the same test. */
const DEFAULT_ORIGIN = "https://passerjack.com";

/**
 * The timeout of Codex's PermissionRequest hook, in seconds:
 * `AWAY_HOOK_TIMEOUT_S` of `bridge/harnesses.mjs`, pinned by the same test.
 * While the owner's "I'm away" switch is on, the hook waits for the owner's
 * answer and stops 30 seconds before this. Codex records trust against a
 * hook's hash, so a changed timeout needs a new trust in `/hooks`.
 */
const AWAY_HOOK_TIMEOUT_S = 3600;

function stop(line) {
  say(line);
  process.exit(1);
}

/**
 * Whether a path cannot go inside double quotes in a hook command on
 * `platform`: a quote or a line break ends the word; `$` and a backtick
 * expand inside double quotes in a POSIX shell and in PowerShell; a
 * backslash escapes in a POSIX shell (on Windows it is the path separator);
 * `%` expands a variable in cmd.exe. A path that holds one is refused, never
 * escaped: no escape is right for every shell that a harness may use.
 */
function unsafeInQuotes(value, platform) {
  if (/["\r\n$`]/.test(value)) return true;
  return platform === "win32" ? value.includes("%") : value.includes("\\");
}

/** A path in double quotes for a hook command. A path that `unsafeInQuotes` names is refused. */
function q(value) {
  if (unsafeInQuotes(value, process.platform)) stop("node: the path has a character that a hook command cannot hold");
  return `"${value}"`;
}

const command = (harness, event) => `${q(NODE)} ${q(BRIDGE)} ${harness} ${event}`;
const ps = (harness, event) => `& ${q(NODE)} ${q(BRIDGE)} ${harness} ${event}`;
const claudeGroup = (harness, event, timeout, matcher) => {
  const group = { hooks: [{ type: "command", command: command(harness, event), timeout }] };
  return matcher ? { matcher, ...group } : group;
};

/** The text of a plugin file, with the absolute paths in place of its placeholders. */
function pluginText(name, harness) {
  return EMBED.files[name]
    .replace('"__PASSERJACK_NODE__"', JSON.stringify(NODE))
    .replace('"__PASSERJACK_BRIDGE__"', JSON.stringify(BRIDGE))
    .replace('"__PASSERJACK_HARNESS__"', JSON.stringify(harness));
}

/** What Grok Build reads in every session: start the monitor that wakes an idle session. */
function grokRule() {
  return [
    "# PasserJack",
    "",
    "PasserJack lets the user send this session a message from the PasserJack Agents page.",
    "",
    "At the start of each session, start ONE persistent monitor with the monitor tool (persistent: true). Start it only once. Its command:",
    "",
    `    ${command("watch", "grok")}`,
    "",
    "Its description: PasserJack messages for this session.",
    "",
    "A line from it that starts with [passerjack] message means that a message for this session arrived. Then end your turn with a short reply. When your turn ends, the PasserJack hook gives you the message from the owner.",
    "",
    "A message from the owner is the user's own words to this session. Act on it as on a line that the user typed here.",
    "",
  ].join("\n");
}

/**
 * EVERY HARNESS: where its hooks go and what they are. `merge` adds entries
 * to lists in a JSON file the user may already have; `own` writes files that
 * are PasserJack's alone; `toml` appends `[[hooks]]` tables to Vibe's file.
 * The paths and shapes are each program's documentation's
 * (docs/plans/2026-11-25-agents-ui/harnesses.html).
 */
const TARGETS = {
  codex: {
    kind: "merge",
    file: () => p(".codex", "hooks.json"),
    container: ["hooks"],
    seed: {},
    events: () => ({
      SessionStart: claudeGroup("codex", "SessionStart", 10),
      UserPromptSubmit: claudeGroup("codex", "UserPromptSubmit", 10),
      Stop: claudeGroup("codex", "Stop", 15),
      // Waits for the owner's answer only while "I'm away" is on; else one 3 s read.
      PermissionRequest: claudeGroup("codex", "PermissionRequest", AWAY_HOOK_TIMEOUT_S),
      // "SessionEnd ... support up to 3 seconds".
      SessionEnd: claudeGroup("codex", "SessionEnd", 3),
    }),
  },
  gemini: {
    kind: "merge",
    file: () => p(".gemini", "settings.json"),
    container: ["hooks"],
    seed: {},
    events: () => {
      const g = (event) => ({ hooks: [{ name: "passerjack", type: "command", command: command("gemini", event), timeout: 15000 }] });
      return { SessionStart: g("SessionStart"), BeforeAgent: g("BeforeAgent"), AfterAgent: g("AfterAgent"), Notification: g("Notification"), SessionEnd: g("SessionEnd") };
    },
  },
  cursor: {
    kind: "merge",
    file: () => p(".cursor", "hooks.json"),
    container: ["hooks"],
    seed: { version: 1 },
    events: () => {
      const c = (event, extra = {}) => ({ command: command("cursor", event), timeout: 15, ...extra });
      return {
        sessionStart: c("sessionStart"),
        beforeSubmitPrompt: c("beforeSubmitPrompt"),
        afterAgentResponse: c("afterAgentResponse"),
        stop: c("stop", { loop_limit: 3 }),
        sessionEnd: c("sessionEnd"),
      };
    },
  },
  junie: {
    kind: "merge",
    file: () => p(".junie", "config.json"),
    container: ["hooks"],
    seed: {},
    // No PermissionRequest until a live walk: an exit 0 with no decision
    // approves the action. The bridge's adapter exits 1 for "no decision",
    // but the hook timeout and the dialog during the hook are not proven.
    events: () => ({
      SessionStart: claudeGroup("junie", "SessionStart", 10),
      UserPromptSubmit: claudeGroup("junie", "UserPromptSubmit", 10),
      Stop: claudeGroup("junie", "Stop", 15),
      SessionEnd: claudeGroup("junie", "SessionEnd", 2),
    }),
  },
  devin: {
    kind: "merge",
    file: () => p(".config", "devin", "config.json"),
    container: ["hooks"],
    seed: {},
    // No PermissionRequest until a live walk: what "no decision" does there is
    // implied by the documentation's example only.
    events: () => ({
      SessionStart: claudeGroup("devin", "SessionStart", 10),
      UserPromptSubmit: claudeGroup("devin", "UserPromptSubmit", 10),
      Stop: claudeGroup("devin", "Stop", 15),
      SessionEnd: claudeGroup("devin", "SessionEnd", 5),
    }),
  },
  continue: {
    kind: "merge",
    file: () => p(".continue", "settings.json"),
    container: ["hooks"],
    seed: {},
    events: () => ({
      SessionStart: claudeGroup("continue", "SessionStart", 10),
      UserPromptSubmit: claudeGroup("continue", "UserPromptSubmit", 10),
      Stop: claudeGroup("continue", "Stop", 15),
      Notification: claudeGroup("continue", "Notification", 10, "permission_prompt"),
      SessionEnd: claudeGroup("continue", "SessionEnd", 5),
    }),
  },
  windsurf: {
    kind: "merge",
    file: () => p(".codeium", "windsurf", "hooks.json"),
    container: ["hooks"],
    seed: {},
    events: () => ({
      pre_user_prompt: { command: command("windsurf", "pre_user_prompt"), show_output: false },
      post_cascade_response: { command: command("windsurf", "post_cascade_response"), show_output: false },
    }),
  },
  antigravity: {
    kind: "merge",
    file: () => p(".gemini", "config", "hooks.json"),
    // Antigravity's file is a map of named hook groups: PasserJack's is one key.
    container: [],
    key: "passerjack",
    seed: {},
    value: () => ({
      enabled: true,
      SessionStart: [{ type: "command", command: command("antigravity", "SessionStart"), timeout: 10 }],
      Stop: [{ type: "command", command: command("antigravity", "Stop"), timeout: 15 }],
    }),
  },
  grok: {
    kind: "own",
    files: () => {
      const g = (event, matcher) => {
        const group = { hooks: [{ type: "command", command: command("grok", event), timeout: 15 }] };
        return matcher ? { matcher, ...group } : group;
      };
      const hooks = {
        hooks: {
          SessionStart: [g("SessionStart")],
          UserPromptSubmit: [g("UserPromptSubmit")],
          Stop: [g("Stop")],
          Notification: [g("Notification", "permission_prompt")],
          SessionEnd: [g("SessionEnd")],
        },
      };
      return [
        { path: p(".grok", "hooks", "passerjack.json"), text: `${JSON.stringify(hooks, null, 2)}\n` },
        { path: p(".grok", "rules", "passerjack.md"), text: grokRule() },
      ];
    },
  },
  copilot: {
    kind: "own",
    files: () => {
      const c = (event) => ({ type: "command", bash: command("copilot", event), powershell: ps("copilot", event), timeoutSec: 15 });
      const hooks = {
        version: 1,
        hooks: {
          sessionStart: [c("sessionStart")],
          userPromptSubmitted: [c("userPromptSubmitted")],
          agentStop: [c("agentStop")],
          notification: [c("notification")],
          sessionEnd: [c("sessionEnd")],
        },
      };
      const home = (process.env.COPILOT_HOME ?? "").trim() || p(".copilot");
      return [{ path: path.join(home, "hooks", "passerjack.json"), text: `${JSON.stringify(hooks, null, 2)}\n` }];
    },
  },
  goose: {
    kind: "own",
    files: () => {
      const g = (event) => [{ hooks: [{ type: "command", command: command("goose", event), timeout: 15 }] }];
      const dir = p(".agents", "plugins", "passerjack");
      return [
        {
          path: path.join(dir, "plugin.json"),
          text: `${JSON.stringify({ name: "passerjack", version: EMBED.version, description: "PasserJack: the Agents page sees this session and can message it" }, null, 2)}\n`,
        },
        {
          path: path.join(dir, "hooks", "hooks.json"),
          text: `${JSON.stringify({ hooks: { SessionStart: g("SessionStart"), UserPromptSubmit: g("UserPromptSubmit"), Stop: g("Stop"), SessionEnd: g("SessionEnd") } }, null, 2)}\n`,
        },
      ];
    },
  },
  opencode: {
    kind: "own",
    files: () => [{ path: p(".config", "opencode", "plugin", "passerjack.js"), text: pluginText("bridge/opencode-plugin.js", "opencode") }],
  },
  kilo: {
    kind: "own",
    files: () => [{ path: p(".config", "kilo", "plugin", "passerjack.js"), text: pluginText("bridge/opencode-plugin.js", "kilo") }],
  },
  amp: {
    kind: "own",
    files: () => [{ path: p(".config", "amp", "plugins", "passerjack.ts"), text: pluginText("bridge/amp-plugin.ts", "amp") }],
  },
  cline: {
    kind: "own",
    // A hook is an executable file named exactly by its event. Not on Windows.
    executable: true,
    noOverwrite: true,
    files: () =>
      ["TaskStart", "TaskResume", "UserPromptSubmit", "TaskComplete", "TaskCancel"].map((event) => ({
        path: p("Documents", "Cline", "Hooks", event),
        text: `#!/bin/sh\nexec ${command("cline", event)}\n`,
      })),
  },
  vibe: {
    kind: "toml",
    file: () => p(".vibe", "hooks.toml"),
    block: () => {
      const t = (name, type, event, match) =>
        [
          "[[hooks]]",
          `name = "passerjack-${name}"`,
          `type = "${type}"`,
          ...(match ? [`match = "${match}"`] : []),
          `command = ${JSON.stringify(command("vibe", event))}`,
          "timeout = 15.0",
          'description = "PasserJack: the Agents page sees this session and can message it."',
          "",
        ].join("\n");
      return [
        "",
        "# PasserJack (added by the PasserJack setup)",
        t("session-start", "session_start", "session_start"),
        t("pre-agent", "pre_agent", "pre_agent", "main"),
        t("post-agent", "post_agent", "post_agent", "main"),
        t("notification", "notification", "notification"),
        t("session-end", "session_end", "session_end"),
      ].join("\n");
    },
  },
};

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function readMaybe(file) {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    stop("file: cannot be read");
  }
}

/** Write `bytes` to `target` in one step: a temporary file beside it, then a rename. */
function writeAtomic(target, bytes, mode) {
  const real = fs.existsSync(target) ? fs.realpathSync(target) : target;
  const dir = path.dirname(real);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(real)}.passerjack-${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    const fd = fs.openSync(temp, "wx", mode);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, real);
    if (!WIN) fs.chmodSync(real, mode);
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      say(`cleanup: not complete: ${temp}`);
    }
    stop("file: cannot be written");
  }
}

/** The bridge's files, each at its place under ROOT. */
function bridgeFiles() {
  const out = Object.entries(EMBED.files).map(([rel, text]) => ({ path: path.join(ROOT, ...rel.split("/")), text }));
  if (EMBED.origin !== DEFAULT_ORIGIN) out.push({ path: path.join(ROOT, "origin.txt"), text: `${EMBED.origin}\n` });
  return out;
}

function bridgeState() {
  let present = 0;
  let same = 0;
  const files = bridgeFiles();
  for (const f of files) {
    const bytes = readMaybe(f.path);
    if (bytes === null) continue;
    present += 1;
    if (sha(bytes) === sha(Buffer.from(f.text))) same += 1;
  }
  if (same === files.length) return "installed";
  return present === 0 ? "missing" : "outdated";
}

function writeBridge() {
  if (bridgeState() === "installed") return say("bridge: up to date");
  const parent = path.dirname(ROOT);
  const made = fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!WIN && made !== undefined) fs.chmodSync(parent, 0o700);
  for (const f of bridgeFiles()) writeAtomic(f.path, Buffer.from(f.text), 0o644);
  say("bridge: written");
}

/** True when this computer has a PasserJack sign-in for the origin. Reads only its origin. */
function signedIn() {
  try {
    const cred = JSON.parse(fs.readFileSync(CREDENTIALS, "utf8"));
    return Boolean(cred && cred.origin === EMBED.origin && (cred.kind === "oauth" || cred.kind === "key"));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* JSON merge                                                          */
/* ------------------------------------------------------------------ */

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const ours = (entry) => JSON.stringify(entry).includes(JSON.stringify(MARK).slice(1, -1));

/**
 * One event list with PasserJack's hooks taken out, and nothing else. A
 * group (`{ matcher?, hooks: [...] }`, the Claude Code shape) loses only the
 * INNER hooks that name the bridge: a hook of the user's own that was merged
 * into a PasserJack group stays, with the group around it. A group left with
 * no hook goes; a flat entry (`{ command }`, Cursor and Windsurf) goes when
 * it names the bridge.
 */
function withoutOurs(list) {
  const out = [];
  for (const entry of list) {
    if (isObject(entry) && Array.isArray(entry.hooks)) {
      const kept = entry.hooks.filter((hook) => !ours(hook));
      if (kept.length === entry.hooks.length) out.push(entry);
      else if (kept.length) out.push({ ...entry, hooks: kept });
    } else if (!ours(entry)) {
      out.push(entry);
    }
  }
  return out;
}

function parseStrict(bytes) {
  if (bytes === null) return null;
  let text = bytes.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    stop("file: does not parse");
  }
}

function indentOf(bytes) {
  const m = bytes ? bytes.toString("utf8").match(/\n([ \t]+)"/) : null;
  return m ? m[1] : 2;
}

/** The container object at `keys` (made when `create`), or null. Stops on a shape it cannot be sure of. */
function containerOf(root, keys, create) {
  if (!isObject(root)) stop("file: has an unexpected shape");
  let node = root;
  for (const key of keys) {
    if (node[key] === undefined) {
      if (!create) return null;
      node[key] = {};
    }
    if (!isObject(node[key])) stop("file: has an unexpected shape");
    node = node[key];
  }
  return node;
}

/** The PasserJack part of a merge target: `{ event: entry }`, or `{ key: value }` for a named group. */
function expectedOf(t) {
  return t.key ? { [t.key]: t.value() } : t.events();
}

function mergeStatus(t, root) {
  const box = containerOf(root, t.container, false);
  if (!box) return "no";
  const want = expectedOf(t);
  let found = 0;
  let exact = 0;
  for (const [name, entry] of Object.entries(want)) {
    if (t.key) {
      if (box[name] === undefined) continue;
      found += 1;
      if (JSON.stringify(box[name]) === JSON.stringify(entry)) exact += 1;
      continue;
    }
    if (box[name] !== undefined && !Array.isArray(box[name])) stop("file: has an unexpected shape");
    const mine = (box[name] ?? []).filter(ours);
    if (!mine.length) continue;
    found += 1;
    if (mine.length === 1 && JSON.stringify(mine[0]) === JSON.stringify(entry)) exact += 1;
  }
  const total = Object.keys(want).length;
  if (exact === total && found === total) return "yes";
  return found === 0 ? "no" : "partly";
}

/** `root` with every PasserJack entry taken out, and lists or containers left empty by that removed. */
function stripped(t, root) {
  const copy = JSON.parse(JSON.stringify(root));
  const box = containerOf(copy, t.container, false);
  if (!box) return copy;
  if (t.key) {
    delete box[t.key];
  } else {
    for (const name of Object.keys(expectedOf(t))) {
      if (!Array.isArray(box[name])) continue;
      const kept = withoutOurs(box[name]);
      if (kept.length) box[name] = kept;
      else delete box[name];
    }
  }
  // A container left empty compares as absent, on both sides of a verify.
  for (let depth = t.container.length; depth > 0; depth -= 1) {
    const parent = depth === 1 ? copy : containerOf(copy, t.container.slice(0, depth - 1), false);
    const key = t.container[depth - 1];
    if (parent && isObject(parent[key]) && Object.keys(parent[key]).length === 0) delete parent[key];
    else break;
  }
  return copy;
}

function addMerge(t, file, bytes) {
  const root = bytes === null ? JSON.parse(JSON.stringify(t.seed)) : parseStrict(bytes);
  const status = mergeStatus(t, root);
  if (status === "yes") return say("hooks: already added");
  const next = stripped(t, root);
  const box = containerOf(next, t.container, true);
  for (const [name, entry] of Object.entries(expectedOf(t))) {
    if (t.key) box[name] = entry;
    else box[name] = [...(Array.isArray(box[name]) ? box[name] : []), entry];
  }
  const out = Buffer.from(`${JSON.stringify(next, null, indentOf(bytes))}\n`);
  if (bytes !== null) {
    const backup = backUp(file, bytes);
    // A save by another program since the first read: change nothing.
    const now = readMaybe(file);
    if (now === null || sha(now) !== sha(bytes)) {
      fs.rmSync(backup, { force: true });
      say("backup: deleted");
      stop("file: changed during the setup");
    }
    const mode = fs.statSync(file).mode & 0o777;
    writeAtomic(file, out, mode);
    say(`backup: ${backup}`);
    say("hooks: added");
  } else {
    writeAtomic(file, out, 0o600);
    say("created: yes");
    say("hooks: added");
  }
}

/* ------------------------------------------------------------------ */
/* Backups                                                             */
/* ------------------------------------------------------------------ */

const BACKUP_RE = /\.bak-passerjack-\d{8}T\d{6}Z-[0-9a-f]{8}$/;

function backUp(file, bytes) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const backup = `${file}.bak-passerjack-${stamp}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    const fd = fs.openSync(backup, "wx", 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    try {
      fs.rmSync(backup, { force: true });
    } catch {
      say(`cleanup: not complete: ${backup}`);
    }
    stop("backup: cannot be written");
  }
  return backup;
}

/** The backup named, when it is one that this script made of this file. */
function backupOf(file, given) {
  if (!given) return null;
  const real = path.resolve(given);
  if (path.dirname(real) !== path.dirname(file) || !path.basename(real).startsWith(`${path.basename(file)}.bak-passerjack-`) || !BACKUP_RE.test(real)) {
    stop("backup: refused, it is not a backup of this file");
  }
  try {
    if (!fs.lstatSync(real).isFile()) throw new Error("not a file");
  } catch {
    stop("backup: refused, it is not a backup of this file");
  }
  return real;
}

/* ------------------------------------------------------------------ */
/* Own files and TOML                                                  */
/* ------------------------------------------------------------------ */

function ownStatus(t) {
  let present = 0;
  let same = 0;
  const files = t.files();
  for (const f of files) {
    const bytes = readMaybe(f.path);
    if (bytes === null) continue;
    present += 1;
    if (sha(bytes) === sha(Buffer.from(f.text))) same += 1;
    else if (t.noOverwrite && !bytes.toString("utf8").includes(MARK)) stop("hooks: a hook of that name exists and is not PasserJack's");
  }
  if (same === files.length) return "yes";
  return present === 0 ? "no" : "partly";
}

function addOwn(t) {
  if (ownStatus(t) === "yes") return say("hooks: already added");
  for (const f of t.files()) writeAtomic(f.path, Buffer.from(f.text), t.executable ? 0o700 : 0o600);
  say("hooks: added");
}

function removeOwn(t) {
  for (const f of t.files()) {
    const bytes = readMaybe(f.path);
    if (bytes === null) continue;
    // Only a file that is PasserJack's: the one this script wrote, or one that names the bridge.
    if (sha(bytes) === sha(Buffer.from(f.text)) || bytes.toString("utf8").includes(MARK)) fs.rmSync(f.path, { force: true });
    // A folder of PasserJack's own (Goose's plugin) goes when it is empty.
    for (let dir = path.dirname(f.path); /passerjack/i.test(path.basename(dir)) || /passerjack/i.test(dir.slice(HOME.length)); dir = path.dirname(dir)) {
      if (!/passerjack/i.test(dir.slice(HOME.length))) break;
      try {
        fs.rmdirSync(dir);
      } catch {
        break;
      }
    }
  }
  say("removed: yes");
}

const TOML_MARK = 'name = "passerjack-';

function tomlStatus(bytes) {
  if (bytes === null) return "no";
  const text = bytes.toString("utf8");
  const want = TARGETS.vibe.block();
  if (text.includes(want)) return "yes";
  return text.includes(TOML_MARK) ? "partly" : "no";
}

function addToml(t, file, bytes) {
  const status = tomlStatus(bytes);
  if (status === "yes") return say("hooks: already added");
  if (status === "partly") stop("hooks: an older PasserJack block is in the file; restore it first");
  const text = bytes === null ? "" : bytes.toString("utf8");
  const out = Buffer.from(`${text}${text && !text.endsWith("\n") ? "\n" : ""}${t.block()}`);
  if (bytes !== null) {
    const backup = backUp(file, bytes);
    writeAtomic(file, out, fs.statSync(file).mode & 0o777);
    say(`backup: ${backup}`);
  } else {
    writeAtomic(file, out, 0o600);
    say("created: yes");
  }
  say("hooks: added");
}

/* ------------------------------------------------------------------ */

function main() {
  const [mode, harness, given] = process.argv.slice(2);
  if (!["check", "add", "verify", "restore"].includes(mode) || !Object.hasOwn(TARGETS, harness)) {
    stop("usage: node passerjack-bridge.cjs check|add|verify|restore <harness> [<backup>]");
  }
  if (Number(process.versions.node.split(".")[0]) < 18) stop("node: 18 or newer is needed");
  if (harness === "cline" && WIN) stop("hooks: this program has no hooks on Windows");
  const t = TARGETS[harness];
  const file = t.file ? t.file() : null;

  if (mode === "check") {
    say(`bridge: ${bridgeState()}`);
    say(`sign-in: ${signedIn() ? "yes" : "no"}`);
    if (t.kind === "own") return say(`hooks: ${ownStatus(t)}`);
    const bytes = readMaybe(file);
    say(`file: ${bytes === null ? "missing" : "ok"}`);
    if (t.kind === "toml") return say(`hooks: ${tomlStatus(bytes)}`);
    return say(`hooks: ${bytes === null ? "no" : mergeStatus(t, parseStrict(bytes))}`);
  }

  if (mode === "add") {
    writeBridge();
    if (t.kind === "own") return addOwn(t);
    const bytes = readMaybe(file);
    if (t.kind === "toml") return addToml(t, file, bytes);
    return addMerge(t, file, bytes);
  }

  if (mode === "verify") {
    say(`bridge as expected: ${bridgeState() === "installed" ? "yes" : "no"}`);
    if (t.kind === "own") return say(`passerjack hooks as expected: ${ownStatus(t) === "yes" ? "yes" : "no"}`);
    const bytes = readMaybe(file);
    if (bytes === null) return say("file: missing");
    const backup = backupOf(file, given);
    if (t.kind === "toml") {
      const before = backup ? fs.readFileSync(backup, "utf8") : "";
      const now = bytes.toString("utf8");
      const block = t.block();
      const sep = before && !before.endsWith("\n") ? "\n" : "";
      say(`others unchanged: ${now === `${before}${sep}${block}` ? "yes" : "no"}`);
      return say(`passerjack hooks as expected: ${tomlStatus(bytes) === "yes" ? "yes" : "no"}`);
    }
    const now = parseStrict(bytes);
    const before = backup ? parseStrict(fs.readFileSync(backup)) : JSON.parse(JSON.stringify(t.seed));
    say(`others unchanged: ${JSON.stringify(stripped(t, now)) === JSON.stringify(stripped(t, before)) ? "yes" : "no"}`);
    return say(`passerjack hooks as expected: ${mergeStatus(t, now) === "yes" ? "yes" : "no"}`);
  }

  // restore
  if (t.kind === "own") return removeOwn(t);
  const backup = backupOf(file, given);
  if (backup) {
    writeAtomic(file, fs.readFileSync(backup), fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600);
    return say("restored: yes");
  }
  const bytes = readMaybe(file);
  if (bytes === null) return say("removed: yes");
  if (t.kind === "toml") {
    const text = bytes.toString("utf8");
    const block = t.block();
    if (!text.includes(block)) return say("removed: yes");
    writeAtomic(file, Buffer.from(text.replace(block, "")), fs.statSync(file).mode & 0o777);
    return say("removed: yes");
  }
  const root = parseStrict(bytes);
  writeAtomic(file, Buffer.from(`${JSON.stringify(stripped(t, root), null, indentOf(bytes))}\n`), fs.statSync(file).mode & 0o777);
  say("removed: yes");
}

if (require.main === module) {
  try {
    main();
  } catch {
    // Only a bug reaches here. No message: it could quote a settings file.
    stop("setup: stopped by an unexpected error");
  }
} else {
  // Loaded by a test (never by a person): the copies it pins, and nothing runs.
  module.exports = { placesFor, DEFAULT_ORIGIN, AWAY_HOOK_TIMEOUT_S, unsafeInQuotes, withoutOurs };
}
