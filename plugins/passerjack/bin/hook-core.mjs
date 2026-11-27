/**
 * THE PLUGIN'S HOOKS, as decisions with their inputs handed in (design
 * `docs/plans/2026-11-25-agents-ui/design.html`, section 6). `hook.mjs` is the
 * entry point Claude Code runs; this module takes the hook's stdin, the
 * environment, a clock, a sleep, the transcript's size, the hooks' state, the
 * Claude Code process's children and the network as arguments, so the unit
 * tests drive it with stubs.
 *
 * ONE MECHANISM, "post after a minute unless the session moved": a hook
 * records where the session is, waits until a minute has passed, and posts
 * only when nothing moved.
 *   - Stop: when `background_tasks` lists live work other than the PasserJack
 *     watcher itself, the session waits on that work and not on the person,
 *     so nothing is posted. Else the hooks' turn counter is read at once and
 *     the transcript's size after a short settle (the transcript takes its
 *     last lines about a second after Stop, measured on 2026-11-25), and
 *     `idle` is posted with the turn's last message (`last_assistant_message`)
 *     unless `PASSERJACK_SHARE_LAST_MESSAGE` is exactly `0`, only when the
 *     counter AND the size did not move. The counter is the hooks' own
 *     (`updateHookState` in `session-link.mjs`): every prompt and every
 *     session start (a `/clear`, a resume, a compaction) bumps it, so a late
 *     `idle` never overwrites the `working` of a turn that started inside the
 *     minute (the bridge's `waiterMayPost`, ported).
 *   - Notification `permission_prompt`: a MARK in the hooks' state
 *     (`pending`), then the minute, then `waiting_permission` with the tool's
 *     NAME only (never its input), from the transcript's one pending tool
 *     call. It posts only when (1) the transcript did not grow, (2) the mark
 *     is still this hook's (a finished tool, a prompt, a Stop or a session
 *     start clears it), and (3) no child process of Claude Code started after
 *     the prompt (an approved Bash tool runs as one; Bash calls of 77 s and
 *     111 s that wrote nothing to the transcript were seen on 2026-11-25).
 *   - Notification `idle_prompt` (Claude Code waits on the person for about a
 *     minute): while a mark is set and not posted, that is positive evidence
 *     that the prompt is still up, and `waiting_permission` is posted at once.
 *   - PostToolUse, and PostToolUseFailure (plugin 0.4.0: an approved tool that
 *     FAILS fires it and no PostToolUse; its input carries `tool_use_id` too,
 *     read from Claude Code 2.1.332 on 2026-11-26): a tool finished, so a
 *     permission prompt that was up was answered. Both run the `tool`
 *     event. ONLY while a mark is set: the mark is cleared and `working` is
 *     posted, which resolves the permission row. A tool call whose
 *     `tool_use_id` is not the marked one (a parallel tool, a subagent's)
 *     clears nothing. A request hook's entry goes only with its own call
 *     (`withoutFinished`), and nothing is posted for it.
 *   - UserPromptSubmit: bump the counter, clear the mark, and post `working`
 *     for every prompt the person TYPED. A turn that a monitor line starts
 *     arrives as a `<task-notification>` prompt, and it says nothing about the
 *     person. EVERY typed prompt, not only one after a posted wait: a question
 *     the agent asked and the person answered at the terminal inside the
 *     minute has no posted wait, and without this post the next turn's `idle`
 *     would push that answered question to the phone (C9). The server answers
 *     a `working` that changes nothing with no frame. Only a typed prompt
 *     also bumps `requestTurn` and ends the request hooks.
 *   - SessionStart: bump the counter and clear the mark; every source but a
 *     compaction (`compact`) also bumps `requestTurn` and ends the request
 *     hooks.
 *   - PermissionRequest (plugin 0.4.0, design
 *     `docs/plans/2026-11-26-remote-permission/design.html`, section 7): the
 *     ONE SYNCHRONOUS HOOK. It runs while the dialog is up, and the dialog
 *     stays answerable at the terminal the whole time. It approves the
 *     plugin's five reply tools of the user's own PasserJack server at once
 *     (D3). For any other prompt it posts a request row with the tool's
 *     input (the only place the input goes), waits for the owner's answer on
 *     the Agents page, and prints that answer as its decision. Any sign that
 *     the prompt was answered at the terminal ends it with no output. It
 *     asks for the push itself after a minute, so the Notification waiter
 *     and `idle_prompt` do nothing while a request hook's row is accepted.
 *
 * SILENT ON EVERY FAILURE: nothing is ever printed (not the message, not a
 * question, not a credential), and the hook exits 0 whatever happened. The
 * one exception is the request hook's decision, ONE JSON object on stdout,
 * printed only when the owner answered from PasserJack (or for a reply tool).
 */

/** How long after Stop the transcript's size is taken as the baseline. */
export const SETTLE_MS = 5000;
/** How long a wait must last, from the hook's start, before it is posted. */
export const WAIT_MS = 60_000;
/** The most characters of a turn's last message sent; the server keeps 8000 and marks the cut. */
export const MAX_SENT_CHARS = 9000;
/** The longest any one post may take. */
export const POST_TIMEOUT_MS = 10_000;
/** How much of the transcript's end is read to find a pending tool call. */
export const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

/** The server's `TOOL_NAME_RE` (`src/lib/agent-conversation-rules.ts`), pinned by the hooks test. */
export const TOOL_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * A child of Claude Code counts as "the approved tool runs" only when it
 * started at least this long after the prompt: the other hooks of the same
 * notification start with this one.
 */
export const CHILD_GRACE_MS = 1000;
/** The background task states that are live work (the bridge's Grok adapter uses them too). */
export const LIVE_TASK_STATES = new Set(["running", "pending", "starting", "queued", "in_progress"]);

// ---------------------------------------------------------------------------
// THE REQUEST HOOK (PermissionRequest, 0.4.0). The numbers that the server
// also has are COPIES of `src/lib/agent-conversation-rules.ts`, pinned by
// `tests/unit/passerjack-plugin-request.test.ts`.

/**
 * The PermissionRequest hook's `timeout` in `hooks/hooks.json`, in seconds:
 * 12 hours. Proven on Claude Code 2.1.332 (2026-11-26): a timeout over 600 s
 * is honored, and a hook alive at 615 s printed allow at 700 s and the tool
 * ran. The owner may answer hours later; a waiting hook costs one process
 * and one request every 25 s.
 */
export const REQUEST_TIMEOUT_S = 43_200;
/** The hook stops waiting at least this long before that timeout, and closes its row as `gone`. */
export const REQUEST_STOP_EARLY_MS = 30_000;
/** A prompt answered at the terminal inside this settle never reaches the page and spends no budget. */
export const REQUEST_SETTLE_MS = 2000;
/**
 * The server's `MAX_PERMISSION_WAIT_SECONDS` (`src/lib/agents-page-http.ts`),
 * pinned by the request test: the long poll holds up to this many seconds,
 * and a longer `wait` is a 400.
 */
export const POLL_WAIT_S = 25;
/** The longest one poll may take: the server's hold and a margin. */
export const POLL_TIMEOUT_MS = 35_000;
/** The margin of a poll over its hold: a poll that holds `waitS` seconds may take `waitS` seconds and this much more. */
export const POLL_MARGIN_MS = POLL_TIMEOUT_MS - POLL_WAIT_S * 1000;
/** How often the terminal signs are read while a poll is open. */
export const SIGN_TICK_MS = 2000;
/** The least time between two polls, when the server answers "open" early. */
export const POLL_MIN_GAP_MS = 2000;
/**
 * A poll that asked the server to hold, and got "open" back sooner than this,
 * was not held: the server's cap of waiting polls for one account answers so
 * (`MAX_PERMISSION_WAITS_PER_USER`), and so does a check that threw. The next
 * poll then waits 2, 4, 8 and then 16 s (`QUICK_BACKOFF_STEPS`), and a held
 * poll starts the count again.
 */
export const QUICK_OPEN_MS = 500;
/** The most doublings of the wait after quick "open" answers: 2 ** 4 = 16 s. */
export const QUICK_BACKOFF_STEPS = 4;
/**
 * The server's `PERMISSION_SWEEP_AFTER_MS` (`src/lib/agent-conversation-rules.ts`,
 * pinned by the request test): the sweep closes a row as `gone` when its hook
 * did not poll for this long. A `closed` answer after a run of failed polls
 * that lasted at least this long can be the sweep, and only then does a hook
 * post its prompt again (`askOwner`).
 */
export const PERMISSION_SWEEP_AFTER_MS = 120_000;
/** The longest wait after a failed poll or post (a `retry-after` is honored up to this). */
export const RETRY_MAX_MS = 30_000;
/** The tries of the request post on a transient failure (no answer, a 401 race, a 429, a 5xx). */
export const REQUEST_POST_TRIES = 4;
/** The server's `MAX_TOOL_INPUT_CHARS`: a longer input is NEVER cut; the hook sends none and `inputTooLong`. */
export const MAX_TOOL_INPUT_CHARS = 4000;
/** The server's `MAX_SESSION_GRANT_CHARS`: a longer grant is not sent, and "Allow for this session" is not offered. */
export const MAX_SESSION_GRANT_CHARS = 2000;
/** The server's `MAX_DENY_NOTE_CHARS`: the most of the owner's Deny note that the model reads. */
export const MAX_DENY_NOTE_CHARS = 500;
/** The server's `PERMISSION_PUSH_AFTER_MS`: a prompt with no sign of an answer for this long asks for a push, once. */
export const PERMISSION_PUSH_AFTER_MS = 60_000;
/** How often the Notification waiter looks for a request hook that took over its prompt. */
export const DEFER_CHECK_MS = 5000;

/**
 * D3: THE REPLY TOOLS that the plugin approves by itself, so an owner
 * message never stalls on a prompt. The names of PasserJack's MCP tools
 * (`src/lib/mcp/tools.ts`, pinned by the request test). Every other
 * PasserJack tool asks.
 */
export const REPLY_TOOLS = Object.freeze(["check_messages", "ack_message", "message_user", "set_status", "list_sessions"]);
/** The MCP server name that the setup installs (`claude mcp add ... passerjack`). */
export const PASSERJACK_MCP_NAME = "passerjack";
/**
 * The `mcp_server.source` values that are the user's own configuration
 * (proven live: a `claude mcp add` server is `user`). A repository's
 * `.mcp.json` is `project` and never matches; any other value (the claude.ai
 * connector's is not proven) does not match either.
 */
export const TRUSTED_MCP_SOURCES = Object.freeze(["user", "local"]);
/**
 * The permission modes that show no dialog: a hook that waited there would
 * hold the turn, so it exits at once and the mode decides. A `-p` run has no
 * monitor, so no link, and the hook exits at "no link".
 */
export const NO_DIALOG_MODES = Object.freeze(["dontAsk", "bypassPermissions"]);
/** The sign that the watcher's link is gone or names another session: the row closes as `gone`, never `terminal`. */
const LINK_GONE = "link-gone";
/** Tools whose Allow needs an `updatedInput` (the answers, the plan) that PasserJack cannot give: the dialog decides. */
export const NEEDS_INPUT_TOOLS = Object.freeze(["AskUserQuestion", "ExitPlanMode"]);
/**
 * Claude Code's shell tools: their input shows as the command as it is
 * (`shownInput`). Every harness names its own (`shellTools` on each adapter
 * of `bridge/harnesses.mjs`); a name that no list holds shows as JSON.
 */
export const CLAUDE_SHELL_TOOLS = Object.freeze(["Bash", "PowerShell"]);
/**
 * THE CLOSED PLAIN LIST: the fields of a shell tool's input, beside the
 * command, that change nothing the owner must see. A shell input with any
 * other field (a sandbox switch, a working folder) shows as JSON, so the
 * owner sees that field. One list for every harness.
 */
export const PLAIN_SHELL_FIELDS = Object.freeze(["command", "description", "timeout", "run_in_background"]);
/** The Claude Code tool whose approved call runs as `eval '<command>'` in a child shell (`shellEvalPattern`). */
const EVAL_SHELL_TOOL = "Bash";

/**
 * The fixed sentence of a Deny from PasserJack, which the model reads as the
 * tool's denial. ONE COPY for every harness: the agent bridge's Tier A and
 * Tier B answers (`bridge/bridge.mjs`, `bridge/harnesses.mjs`) import
 * `denyMessage` from here, so a Claude Code session and a Codex session read
 * the same words.
 */
export const DENY_SENTENCE = "The owner denied this tool call from PasserJack.";

/**
 * Is a background task the PasserJack watcher itself? Its command runs
 * `bin/watch.mjs` of this plugin, or its description is the monitor's own.
 */
export function isOwnWatcher(task, pluginRoot) {
  const command = typeof task?.command === "string" ? task.command : "";
  const description = typeof task?.description === "string" ? task.description : "";
  if (description.startsWith("PasserJack inbox")) return true;
  if (!command.includes("watch.mjs")) return false;
  return Boolean(pluginRoot && command.includes(pluginRoot)) || /passerjack/i.test(command);
}

/** Does the session wait on live background work (not on the person)? */
export function waitsOnWork(tasks, pluginRoot) {
  if (!Array.isArray(tasks)) return false;
  return tasks.some((task) => {
    const status = typeof task?.status === "string" ? task.status.toLowerCase() : "";
    return LIVE_TASK_STATES.has(status) && !isOwnWatcher(task, pluginRoot);
  });
}

/** A prompt the person typed, as opposed to a turn a monitor line or a task started. */
export function typedPrompt(prompt) {
  if (typeof prompt !== "string") return true;
  return !prompt.trimStart().startsWith("<task-notification>");
}

/** At most `MAX_SENT_CHARS` characters, whole code points. */
export function clipText(text) {
  const points = Array.from(text);
  return points.length <= MAX_SENT_CHARS ? text : points.slice(0, MAX_SENT_CHARS).join("");
}

/** The tool named in a notification's message, when Claude Code names one. */
export function toolFromMessage(message) {
  if (typeof message !== "string") return null;
  const match = new RegExp(`permission to use (${TOOL_RE.source.slice(1, -1)})`).exec(message);
  return match ? match[1] : null;
}

/**
 * The tool call still waiting for its result in a transcript's JSONL tail:
 * the newest assistant entry's tool calls minus every one a later entry
 * answered. Exactly one left is `{ name, id }` (either may be null when it
 * is not a shape the server or the state takes); none or several is null.
 */
export function pendingToolCall(jsonl) {
  const calls = new Map();
  for (const line of String(jsonl).split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use" && typeof block.id === "string") {
        if (entry.type === "assistant") calls.set(block.id, block.name);
      } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        calls.delete(block.tool_use_id);
      }
    }
  }
  if (calls.size !== 1) return null;
  const [[id, name]] = [...calls.entries()];
  return {
    name: typeof name === "string" && TOOL_RE.test(name) ? name : null,
    id: /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null,
  };
}

/** The name of the one pending tool call, or null. */
export function pendingToolName(jsonl) {
  return pendingToolCall(jsonl)?.name ?? null;
}

/** The characters of a text as Postgres's `char_length` counts them: code points. */
export function codePoints(text) {
  return Array.from(text).length;
}

/** JSON with every object's keys in order, so two inputs compare equal however their keys were ordered. */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The `tool_use_id` of the call a PermissionRequest is for, from the
 * transcript's tail (the hook's input has no `tool_use_id`): the one pending
 * call with this name AND this input (keys in any order). None or several is
 * null. NEVER the one pending call of the name alone (/dcr wave 1 finding 8):
 * while this call's line has not landed, that is ANOTHER call, and its finish
 * would read as this one's. An entry with no id is cleared by its call's name
 * and input instead (`withoutFinished`).
 *
 * @param {string} jsonl
 * @param {string} toolName
 * @param {unknown} toolInput
 */
export function pendingCallFor(jsonl, toolName, toolInput) {
  const calls = new Map();
  for (const line of String(jsonl).split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use" && typeof block.id === "string") {
        if (entry.type === "assistant") calls.set(block.id, block);
      } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        calls.delete(block.tool_use_id);
      }
    }
  }
  const named = [...calls.entries()].filter(([, block]) => block.name === toolName);
  const wanted = stableJson(toolInput ?? null);
  const same = named.filter(([, block]) => stableJson(block.input ?? null) === wanted);
  const pick = same.length === 1 ? same[0] : null;
  return pick && /^[A-Za-z0-9_-]{1,128}$/.test(pick[0]) ? pick[0] : null;
}

/**
 * The text a call digest is made of: the tool's name and its input, keys in
 * order. `digest` (sha256 in `hook.mjs`) turns it into the `call` of a request
 * entry; the hooks' state never holds the input itself.
 */
export function callText(toolName, toolInput) {
  return stableJson([typeof toolName === "string" ? toolName : null, toolInput ?? null]);
}

/** The digest of a call, or null when the hook has no digest (an earlier build's deps). */
function callDigestOf(deps, toolName, toolInput) {
  if (typeof deps.digest !== "function") return null;
  try {
    return deps.digest(callText(toolName, toolInput));
  } catch {
    return null;
  }
}

/**
 * THE REQUEST ENTRIES LEFT WHEN ONE TOOL CALL FINISHED (a PostToolUse or a
 * PostToolUseFailure with `tool_use_id` `id` and the call digest `call`;
 * /dcr wave 1 findings 8 and 43). An entry with an id goes only with that id.
 * An entry with NO id (the transcript did not hold the call in time, two
 * calls were the same, or a subagent's call went to another transcript) goes
 * only with a finished call of the same name AND input (`call`), and ONE such
 * entry for each finished call, the oldest: until 2026-11-26 any finished
 * tool of the session (a parallel subagent's Read) took it, and the page said
 * "answered at the terminal" while the dialog was still up. A finished call
 * whose id cleared its own entry clears no other. An entry with neither an id
 * nor a digest (a hooks' state that an earlier build wrote) goes with any
 * finished tool, the old rule.
 *
 * @param {{ toolUseId: string | null, call?: string | null }[]} requests
 * @param {string | null} id
 * @param {string | null} call
 */
export function withoutFinished(requests, id, call) {
  let spent = Boolean(id && requests.some((r) => r.toolUseId === id));
  return requests.filter((r) => {
    if (id && r.toolUseId === id) return false;
    if (r.toolUseId && id) return true;
    if (!r.toolUseId && !r.call) return false;
    if (spent || !call || r.call !== call) return true;
    spent = true;
    return false;
  });
}

/** Does the transcript's tail hold the result of tool call `id`? */
export function hasToolResult(jsonl, id) {
  if (!id) return false;
  for (const line of String(jsonl).split("\n")) {
    if (!line.includes(id)) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (Array.isArray(content) && content.some((b) => b?.type === "tool_result" && b.tool_use_id === id)) return true;
  }
  return false;
}

/**
 * D3: is this a reply tool of the user's own PasserJack server, for this
 * session? `tool_name` is `mcp__passerjack__<tool>` with `<tool>` one of
 * `REPLY_TOOLS`; `mcp_server` is `{ name: "passerjack", source: "user" |
 * "local" }`; and a `sessionId` in the input is the link's session. The match
 * is by the server's name and source, so a server added under another name
 * just asks.
 *
 * @param {Record<string, unknown>} input
 * @param {{ sessionId: string } | null} link
 */
export function replyToolApproved(input, link) {
  const name = input.tool_name;
  const prefix = `mcp__${PASSERJACK_MCP_NAME}__`;
  if (typeof name !== "string" || !name.startsWith(prefix) || !REPLY_TOOLS.includes(name.slice(prefix.length))) return false;
  const server = /** @type {any} */ (input.mcp_server);
  if (!server || typeof server !== "object" || server.name !== PASSERJACK_MCP_NAME || !TRUSTED_MCP_SOURCES.includes(server.source)) return false;
  const args = /** @type {any} */ (input.tool_input ?? {});
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  if (Object.hasOwn(args, "sessionId")) {
    if (typeof args.sessionId !== "string" || !link) return false;
    if (args.sessionId.trim().toLowerCase() !== link.sessionId.toLowerCase()) return false;
  }
  return true;
}

/**
 * The bare command of a shell tool's input, or null: only for a tool on the
 * harness's own `shellTools` list, only for a string `command`, and only when
 * every other field is on the closed plain list (`PLAIN_SHELL_FIELDS`).
 *
 * @param {unknown} toolName
 * @param {unknown} toolInput
 * @param {readonly string[]} [shellTools]
 */
export function shellCommandOf(toolName, toolInput, shellTools = CLAUDE_SHELL_TOOLS) {
  if (typeof toolName !== "string" || !shellTools.includes(toolName) || !isRecord(toolInput)) return null;
  const input = /** @type {Record<string, unknown>} */ (toolInput);
  if (typeof input.command !== "string") return null;
  return Object.keys(input).every((k) => PLAIN_SHELL_FIELDS.includes(k)) ? input.command : null;
}

/**
 * WHAT THE OWNER SEES OF A TOOL'S INPUT, THE ONE RULE FOR EVERY HARNESS (/dcr
 * wave 1 findings 62 and 66): the Claude Code hook, every adapter of the
 * agent bridge (`bridge/harnesses.mjs`, each with its own `shellTools`) and
 * the opencode shim's prompt all show an input by this function. The bare
 * command only for the harness's own shell tool whose other fields are all
 * on the closed plain list (`shellCommandOf`); EVERY other shape as compact
 * JSON, so the owner sees every field (a sandbox switch, the target of an MCP
 * tool's `command`). Until 2026-11-26 the bridge showed only `command` for ANY
 * tool, so an Allow could run a field the owner never saw. Over
 * `MAX_TOOL_INPUT_CHARS` code points it is NEVER cut:
 * `{ toolInput: null, inputTooLong: true }`, and the owner can only Deny.
 * Null when there is nothing to show (no input, an empty or blank command):
 * the caller then takes no part, because an Allow of an input that the owner
 * did not see is never offered.
 *
 * @param {unknown} toolName
 * @param {unknown} toolInput
 * @param {readonly string[]} [shellTools]
 * @returns {{ toolInput: string | null, inputTooLong: boolean } | null}
 */
export function shownInput(toolName, toolInput, shellTools = CLAUDE_SHELL_TOOLS) {
  if (toolInput === undefined || toolInput === null) return null;
  let text = shellCommandOf(toolName, toolInput, shellTools);
  if (text === null) {
    try {
      text = JSON.stringify(toolInput);
    } catch {
      return null;
    }
  }
  if (typeof text !== "string" || text.trim() === "") return null;
  return codePoints(text) > MAX_TOOL_INPUT_CHARS ? { toolInput: null, inputTooLong: true } : { toolInput: text, inputTooLong: false };
}

/** A regular expression that matches `text` as it is. */
function literal(text) {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/**
 * THE ONE CALL-SPECIFIC SIGN OF A TERMINAL YES FOR A SHELL CALL (/dcr wave 1
 * finding 64). FACT, captured on Claude Code 2.1.332 at 13:35 on 2026-11-26
 * (`/tmp/agents-ui/research/terminal-yes-capture.log`): after a terminal Yes
 * on a long Bash call, the PermissionRequest hook stays alive, and NO
 * transcript line and NO hook event come until the tool ends. The one sign is
 * a child of the Claude Code process, the shell, whose command line holds
 * `eval '<the command>'`, the command single-quoted with each `'` written as
 * `'"'"'`. This is the pattern of that text, as `ps -ww` prints it under
 * `LC_ALL=C` (`childCommandsOf` in `programs.mjs`): a line feed as `\012` (or
 * `?`, procps), a tab as `\011` (or `?`). It is ANCHORED: a space or the start
 * before `eval`, and a space or the end after the closing quote, so a command
 * that is a prefix of another never matches. Null (no sign at all) for a
 * command with any other character that `ps` does not print as it is (a
 * control character, any character over 126). A Claude Code that quotes in
 * another way only turns the sign OFF, never on: the request hook then waits
 * as it did before.
 *
 * @param {string} command
 * @returns {RegExp | null}
 */
export function shellEvalPattern(command) {
  if (typeof command !== "string" || command.trim() === "") return null;
  let source = "";
  for (const ch of `eval '${command.replaceAll("'", `'"'"'`)}'`) {
    const code = /** @type {number} */ (ch.codePointAt(0));
    if (code >= 0x20 && code <= 0x7e) source += literal(ch);
    else if (ch === "\n") source += "(?:\\\\012|\\n|\\?)";
    else if (ch === "\t") source += "(?:\\\\011|\\t|\\?)";
    else return null;
  }
  return new RegExp(`(?:^|\\s)${source}(?=\\s|$)`);
}

/**
 * Did this child start AT OR AFTER `at`? `elapsedMs` is `ps`'s age in whole
 * seconds, taken at `now`, so the child started after `now - elapsedMs - 1000`.
 * No grace, unlike `startedAfter`: the other hooks of the same prompt are
 * never an `eval '<this command>'` shell, and a person who answers within a
 * second or two must still close the row.
 */
export function startedSince(child, at, now) {
  return Number.isFinite(child?.elapsedMs) && child.elapsedMs + 1000 <= now - at;
}

/**
 * Does the shell of THIS call run? A child of Claude Code that started at or
 * after the prompt (`startedSince`: an identical command that ran before the
 * prompt does not count) and whose command line matches `pattern`
 * (`shellEvalPattern`). A child that merely started after the prompt is NOT a
 * sign: a parallel subagent's or a background task's shell is such a child.
 *
 * @param {{ elapsedMs: number, command: string | null }[] | null} children
 * @param {RegExp | null} pattern
 * @param {number} at
 * @param {number} now
 */
export function shellCallRuns(children, pattern, at, now) {
  if (!pattern || !Array.isArray(children)) return false;
  return children.some((c) => isCallShell(c, pattern, at, now));
}

/** One child that `shellCallRuns` counts: its command line matches, and it started at or after `at`. */
function isCallShell(c, pattern, at, now) {
  return typeof c?.command === "string" && startedSince(c, at, now) && pattern.test(c.command);
}

/**
 * The pids of the children that `shellCallRuns` counts, in the table's order.
 *
 * @param {{ pid?: number, elapsedMs: number, command: string | null }[] | null} children
 * @param {RegExp | null} pattern
 * @param {number} at
 * @param {number} now
 * @returns {number[]}
 */
export function shellsOfCall(children, pattern, at, now) {
  if (!pattern || !Array.isArray(children)) return [];
  return children.filter((c) => Number.isSafeInteger(c?.pid) && isCallShell(c, pattern, at, now)).map((c) => /** @type {number} */ (c.pid));
}

/**
 * ONE SHELL CLOSES ONE ROW (/dcr wave 2): two prompts of one Claude Code
 * process can wait for the SAME command (parallel subagents), and one shell
 * that runs it matches both. Request `n` may count a shell only when no other
 * request of the process claimed it: the claim is written into the hooks'
 * state under its lock (`claims`, one `{ pid, n }` for each claimed shell)
 * and lives while the shell runs, so a claim outlives the hook that made it.
 * Claims of shells that exited are dropped first. Changes `state` in place
 * and answers whether `n` holds a shell of `runs` now. Which of two identical
 * prompts a shell belongs to cannot be read from outside; both rows show the
 * same command, so the count is what matters.
 *
 * @param {{ claims?: { pid: number, n: number }[] }} state
 * @param {number} n
 * @param {number[]} runs
 * @param {((pid: number) => boolean) | undefined} alive
 */
export function claimShell(state, n, runs, alive) {
  const claims = Array.isArray(state.claims) ? state.claims : (state.claims = []);
  const live = claims.filter((c) => !alive || alive(c.pid));
  claims.splice(0, claims.length, ...live);
  if (claims.some((c) => c.n === n && runs.includes(c.pid))) return true;
  const taken = new Set(claims.map((c) => c.pid));
  const free = runs.find((pid) => !taken.has(pid));
  if (free === undefined) return false;
  if (claims.length >= MAX_SHELL_CLAIMS) claims.shift();
  claims.push({ pid: free, n });
  return true;
}

/** The most shell claims a hooks' state keeps (the same bound as its request marks). */
const MAX_SHELL_CLAIMS = 32;

/*
 * THE SHAPE RULE OF A SESSION GRANT ENTRY, a copy of `sessionGrantEntries` in
 * the client-safe leaf `src/lib/agent-conversation-rules.ts` (this module has
 * no imports). The leaf is the rule that the server keeps a grant by, that the
 * decision door refuses "Allow for this session" by and that the page lists
 * the rules by. `tests/unit/passerjack-plugin-request.test.ts` runs the
 * captured shapes and more than twenty bad entries through this copy and the
 * leaf and expects the same verdict for each.
 */
/**
 * The keys an `addRules` entry may carry: the leaf's, and the `destination`
 * that the hook takes off. EXPORTED, with the two below, so the request test
 * compares the sets themselves with the leaf's (/dcr wave 1 finding 19): a key
 * added on one side only fails that test, not only a verdict on an example.
 */
export const ADD_RULES_KEYS = new Set(["type", "behavior", "rules", "destination"]);
/** The keys one rule may carry. */
export const GRANT_RULE_KEYS = new Set(["toolName", "ruleContent"]);
/** The keys an `addDirectories` entry may carry, the `destination` again included. */
export const ADD_DIRECTORIES_KEYS = new Set(["type", "directories", "destination"]);
/** The key that the hook takes off every entry, and puts back as `session` in its own copy. */
const GRANT_DESTINATION_KEY = "destination";

/** An object that is not a list. */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every key of `value` is one of `allowed`. */
function onlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

/** A string with at least one character. */
function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/** One rule of an `addRules` entry: a tool name, and no content or a non-empty one, and no other key. */
function grantRuleOk(rule) {
  return (
    isRecord(rule) &&
    onlyKeys(rule, GRANT_RULE_KEYS) &&
    nonEmptyString(rule.toolName) &&
    (rule.ruleContent === undefined || nonEmptyString(rule.ruleContent))
  );
}

/** A copy of `value` with every key of `allowed` that it carries, the destination left out. */
function keptKeys(value, allowed) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(value)) {
    if (key !== GRANT_DESTINATION_KEY && allowed.has(key)) out[key] = value[key];
  }
  return out;
}

/**
 * The entries of a session grant that pass the leaf's rule, each with its
 * `destination` taken off (`sessionGrantOf` below). Every key that the rule
 * allows is copied, never only the ones this code knows of today: a key added
 * to one side only then reaches the leaf, which refuses the grant, and is
 * never silently dropped (a dropped key that narrows a rule would grant more).
 *
 * @param {unknown} suggestions
 * @returns {Record<string, unknown>[]}
 */
function grantEntries(suggestions) {
  const entries = [];
  for (const s of Array.isArray(suggestions) ? suggestions : []) {
    if (!isRecord(s)) continue;
    if (s.type === "addRules") {
      if (!onlyKeys(s, ADD_RULES_KEYS) || s.behavior !== "allow" || !Array.isArray(s.rules)) continue;
      if (!s.rules.length || !s.rules.every(grantRuleOk)) continue;
      entries.push({ ...keptKeys(s, ADD_RULES_KEYS), rules: s.rules.map((r) => keptKeys(r, GRANT_RULE_KEYS)) });
    } else if (s.type === "addDirectories") {
      if (!onlyKeys(s, ADD_DIRECTORIES_KEYS) || !Array.isArray(s.directories)) continue;
      if (!s.directories.length || !s.directories.every(nonEmptyString)) continue;
      entries.push({ ...keptKeys(s, ADD_DIRECTORIES_KEYS), directories: [...s.directories] });
    }
  }
  return entries;
}

/**
 * D6: the session grant, from `permission_suggestions`. ONE list, filtered
 * once: every `addRules` entry with `behavior: "allow"` and every
 * `addDirectories` entry, each with its `destination` taken off. `json` is
 * what the page shows; `apply` is the hook's OWN copy, the same entries with
 * every destination forced to `session`, printed as `updatedPermissions`
 * only when the owner chose "Allow for this session". The hook never applies
 * what the server sends back. Null when there is no such entry or the JSON is
 * over `MAX_SESSION_GRANT_CHARS` (then neither copy exists, and the request
 * hook traces `grant-too-long`).
 *
 * IT FAILS CLOSED, ENTRY BY ENTRY, BY THE LEAF'S RULE (above). An entry that
 * the leaf would refuse is DROPPED here, whole, and never made into a
 * smaller or a larger one: a rule with no tool name, a `ruleContent` that is
 * not a non-empty string (an empty one is NEVER read as "any input", which
 * is what a rule with no content means), an empty list of rules or folders,
 * an empty folder, and a key that the rule does not know (a later Claude Code
 * could add a key that narrows a rule, and a copy without it would grant
 * more than was asked). The leaf refuses the WHOLE grant for one bad entry,
 * so a bad entry that got through would take "Allow for this session" away
 * from the good ones too.
 *
 * @param {unknown} suggestions
 */
export function sessionGrantOf(suggestions) {
  const entries = grantEntries(suggestions);
  if (!entries.length) return null;
  const json = JSON.stringify(entries);
  if (codePoints(json) > MAX_SESSION_GRANT_CHARS) return null;
  return { json, apply: entries.map((e) => ({ ...e, [GRANT_DESTINATION_KEY]: "session" })) };
}

/** Is there a grant that `sessionGrantOf` dropped only for its length? (The request hook's `grant-too-long` trace.) */
export function grantTooLong(suggestions) {
  const entries = grantEntries(suggestions);
  return entries.length > 0 && codePoints(JSON.stringify(entries)) > MAX_SESSION_GRANT_CHARS;
}

/**
 * The decision a request hook prints for Allow, with the session grant's entries for "Allow for this session".
 *
 * @param {Record<string, unknown>[] | null} [updatedPermissions]
 */
export function allowOutput(updatedPermissions = null) {
  const decision = { behavior: "allow" };
  if (Array.isArray(updatedPermissions) && updatedPermissions.length) decision.updatedPermissions = updatedPermissions;
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}

/**
 * The words the agent reads for a Deny from PasserJack: `DENY_SENTENCE`, and
 * the owner's own note after it, framed as the owner's words, when there is
 * one (no control character, no bidi override, at most
 * `MAX_DENY_NOTE_CHARS`). Never `interrupt`. The one copy: the Claude Code
 * hook, the agent bridge's waiting-first hooks and the opencode shim's reply
 * all print these words.
 */
export function denyMessage(note) {
  if (typeof note !== "string") return DENY_SENTENCE;
  const flat = note.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").trim();
  const cut = Array.from(flat).slice(0, MAX_DENY_NOTE_CHARS).join("").trim();
  return cut ? `${DENY_SENTENCE} The owner wrote: ${cut}` : DENY_SENTENCE;
}

/** The decision a request hook prints for Deny. */
export function denyOutput(note) {
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: denyMessage(note) } } };
}

/** The wait after the `attempt`-th failure (1 s doubling), or the server's `retry-after`, at most `RETRY_MAX_MS`. */
export function retryDelay(attempt, retryAfterMs = null) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return Math.min(retryAfterMs, RETRY_MAX_MS);
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), RETRY_MAX_MS);
}

/** A status that a later try can fix: no answer (0), a 401 while the watcher rotates the token, a 408, a 425, a 429, a 5xx. */
function transientStatus(status) {
  return status === 0 || status === 401 || status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Is a live request hook in charge of this session's prompt push? A request
 * entry whose row the server ACCEPTED and whose hook still runs. While one
 * is, the Notification waiter and `idle_prompt` post nothing: the request
 * hook asks for the push itself after its minute.
 */
export function requestInCharge(state, alive) {
  return (state?.requests ?? []).some((r) => r.accepted && (alive ? alive(r.pid) : true));
}

/**
 * Did this child of Claude Code start at least `CHILD_GRACE_MS` after `at`?
 * `elapsedMs` is `ps`'s age in whole seconds, taken at `now`, so the child
 * started in `(now - elapsedMs - 1000, now - elapsedMs]`.
 */
export function startedAfter(child, at, now) {
  return Number.isFinite(child?.elapsedMs) && child.elapsedMs + 1000 <= now - at - CHILD_GRACE_MS;
}

/**
 * Wait until a minute has passed since `startedAt` and say whether the
 * transcript is the size it was at `baseline` (the session did not move).
 */
async function stillAfterMinute(deps, transcript, baseline, startedAt) {
  const left = startedAt + WAIT_MS - deps.now();
  if (left > 0) await deps.sleep(left);
  return stillSize(deps, transcript, baseline);
}

/** Is the transcript still the size it was at `baseline`? */
function stillSize(deps, transcript, baseline) {
  const size = deps.size(transcript);
  return size !== null && size === baseline;
}

/**
 * Sleep until a minute has passed since `startedAt`, in steps of
 * `DEFER_CHECK_MS`. True as soon as a request hook is in charge of the prompt
 * (`requestInCharge`), false at the minute.
 */
async function deferUntilMinute(deps, startedAt) {
  for (;;) {
    const left = startedAt + WAIT_MS - deps.now();
    if (left <= 0) return false;
    await deps.sleep(Math.min(left, DEFER_CHECK_MS));
    if (requestInCharge(deps.state(), deps.alive)) return true;
  }
}

/**
 * Run one hook. `event` is `stop`, `permission`, `idle`, `tool`, `prompt`,
 * `start` or `request`; `input` is the parsed stdin. Resolves to what was
 * posted (`idle`, `waiting_permission`, `working`) or null; for `request`,
 * to the decision object to print, or null for no output. Never throws.
 *
 * The request hook's own deps (`runRequest`): `pid`, `alive(pid)`,
 * `randomKey()`, `remote(link)` (D8: may this hook's bearer get remote
 * answers), `request(link, body)` (the request post), `poll(link, key,
 * signs, waitS, probe)` (the long poll, held at most `waitS` seconds; `signs`
 * is read every `SIGN_TICK_MS`, `probe` (async, may be null) one at a time,
 * and a truthy answer of either ends the poll as `{ sign }`), `action(link,
 * key, body)` (close and push; resolves to the status), `childCommands()`
 * (the children of Claude Code with their command lines, for the shell sign
 * only), `digest(text)` (sha256 hex of a call's text, `callText`) and
 * `trace(...words)`. The `tool` event uses `digest` too.
 *
 * @param {"stop" | "permission" | "idle" | "tool" | "prompt" | "start" | "request"} event
 * @param {Record<string, unknown>} input
 * @param {{
 *   env: Record<string, string | undefined>,
 *   now: () => number,
 *   sleep: (ms: number) => Promise<void>,
 *   size: (file: string) => number | null,
 *   tail: (file: string) => string,
 *   link: () => { sessionId: string, origin: string } | null,
 *   post: (link: { sessionId: string, origin: string }, body: Record<string, unknown>) => Promise<boolean>,
 *   state: () => { turn: number, marks: number, pending: null | { n: number, at: number, tool: string | null, toolUseId: string | null, posted: boolean } } | null,
 *   update: <T>(fn: (state: { turn: number, marks: number, pending: any }) => T) => Promise<T | null>,
 *   children: () => Promise<{ pid: number, elapsedMs: number }[] | null>,
 *   claudeAlive?: () => boolean,
 * }} deps
 */
export async function runHook(event, input, deps) {
  try {
    const startedAt = deps.now();
    const transcript = typeof input.transcript_path === "string" ? input.transcript_path : null;

    if (event === "start") {
      await deps.update((s) => {
        s.turn += 1;
        s.pending = null;
        // A COMPACTION keeps the request hooks (/dcr wave 1 finding 56): it
        // says nothing about a prompt that is up, and a background agent's
        // dialog can outlive it. `startup`, `resume`, `clear` and a source
        // this hook does not know end them, as before.
        if (input.source !== "compact") {
          s.requestTurn = (s.requestTurn ?? 0) + 1;
          s.requests = [];
        }
      });
      return null;
    }

    if (event === "request") return await runRequest(input, deps, startedAt, transcript);

    if (event === "prompt") {
      // Every prompt is a sign of life, a monitor's turn too: a Stop waiter of
      // the turn before must not post `idle` over the turn that started.
      // ONLY a prompt the person TYPED ends the request hooks (/dcr wave 1
      // finding 56): a turn that a monitor line starts (an owner message
      // from the Agents page, a tagged item) says nothing about a prompt that
      // is up, and the owner who came to answer it would lose the answer path.
      const typed = typedPrompt(input.prompt);
      await deps.update((s) => {
        s.turn += 1;
        s.pending = null;
        if (typed) {
          s.requestTurn = (s.requestTurn ?? 0) + 1;
          s.requests = [];
        }
      });
      if (!typed) return null;
      const link = deps.link();
      if (!link) return null;
      return (await deps.post(link, { state: "working" })) ? "working" : null;
    }

    if (event === "tool") {
      // Most PostToolUse fires find no mark: read first, lock only when there is one.
      const seen = deps.state();
      if (!seen?.pending && !seen?.requests?.length) return null;
      const id = typeof input.tool_use_id === "string" ? input.tool_use_id : null;
      const finished = seen.requests?.length ? callDigestOf(deps, input.tool_name, input.tool_input) : null;
      const cleared = await deps.update((s) => {
        // A request hook's entry for this call goes (its hook then closes its
        // own row as answered at the terminal, and posts nothing here: a
        // `working` would close every other open prompt's row too). By its
        // id, or for an entry with no id by the call's name and input.
        s.requests = withoutFinished(s.requests, id, finished);
        const p = s.pending;
        if (!p) return null;
        if (p.toolUseId && id && id !== p.toolUseId) return null;
        s.pending = null;
        return p;
      });
      if (!cleared) return null;
      const link = deps.link();
      if (!link) return null;
      return (await deps.post(link, { state: "working" })) ? "working" : null;
    }

    if (event === "idle") {
      if (input.notification_type !== undefined && input.notification_type !== "idle_prompt") return null;
      const link = deps.link();
      if (!link) return null;
      const seen = deps.state();
      // A request hook took this prompt: it asks for the push itself.
      if (requestInCharge(seen, deps.alive)) return null;
      const pending = seen?.pending;
      if (!pending || pending.posted) return null;
      // The same check as the permission waiter's (/dcr wave 2): `idle_prompt`
      // can fire a minute after the approval while the approved tool runs.
      const kids = await deps.children();
      const checkedAt = deps.now();
      if (kids && kids.some((child) => startedAfter(child, pending.at, checkedAt))) return null;
      const claimed = await deps.update((s) => {
        if (!s.pending || s.pending.n !== pending.n || s.pending.posted) return null;
        s.pending.posted = true;
        return { ...s.pending };
      });
      if (!claimed) return null;
      return postPermission(deps, link, claimed);
    }

    const link = deps.link();
    if (!link || !transcript) return null;

    if (event === "stop") {
      // The turn ended: a permission prompt that was up was answered (a denied
      // one runs no tool, so no PostToolUse clears it).
      // A request hook's entry goes too, but NOT while live background work
      // runs: a background agent's prompt can still be up after the main
      // turn ended, and its hook must keep the owner's answer path.
      const busy = waitsOnWork(input.background_tasks, deps.env.CLAUDE_PLUGIN_ROOT);
      const turn = await deps.update((s) => {
        s.pending = null;
        if (!busy) s.requests = [];
        return s.turn;
      });
      if (busy) return null;
      await deps.sleep(SETTLE_MS);
      const baseline = deps.size(transcript);
      if (baseline === null) return null;
      if (!(await stillAfterMinute(deps, transcript, baseline, startedAt))) return null;
      // A prompt or a session start inside the minute: that turn's `working` stands.
      if (turn !== null && deps.state()?.turn !== turn) return null;
      const body = { state: "idle" };
      const text = input.last_assistant_message;
      if (deps.env.PASSERJACK_SHARE_LAST_MESSAGE !== "0" && typeof text === "string" && text.trim()) {
        body.lastMessage = clipText(text);
      }
      return (await deps.post(link, body)) ? "idle" : null;
    }

    if (event === "permission") {
      if (input.notification_type !== undefined && input.notification_type !== "permission_prompt") return null;
      // A request hook took this prompt (its row is on the server): it asks
      // for the push itself, so this waiter does nothing. A prompt that no
      // request hook saw (a sandboxed network request) keeps today's path.
      if (requestInCharge(deps.state(), deps.alive)) return null;
      // The mark goes up AT ONCE, so a quick approval's PostToolUse finds and
      // clears it, with the one pending call's name and `tool_use_id` when the
      // transcript already holds its line. The transcript lands late (about a
      // second at Stop), so when it did not, the tail is read again after the
      // settle and the mark gets its id then: a mark with no id lets any
      // PostToolUse (a parallel tool's, a subagent's) clear it (/dcr wave 2).
      const early = pendingToolCall(deps.tail(transcript));
      const mark = await deps.update((s) => {
        s.marks += 1;
        s.pending = { n: s.marks, at: startedAt, tool: toolFromMessage(input.message) ?? early?.name ?? null, toolUseId: early?.id ?? null, posted: false };
        return s.pending.n;
      });
      if (mark === null) return null;
      await deps.sleep(Math.min(SETTLE_MS, 2000));
      const late = early ? null : pendingToolCall(deps.tail(transcript));
      if (late) {
        await deps.update((s) => {
          if (s.pending?.n !== mark) return;
          if (s.pending.toolUseId === null) s.pending.toolUseId = late.id ?? null;
          if (s.pending.tool === null) s.pending.tool = late.name ?? null;
        });
      }
      const baseline = deps.size(transcript);
      if (baseline === null) return null;
      // The minute, in steps: a request hook whose row the server took in the
      // meantime (its post was slow) takes the prompt over, and this waiter
      // leaves well before that hook's own minute, so its child check never
      // counts this process as an approved tool.
      if (await deferUntilMinute(deps, startedAt)) {
        await deps.update((s) => {
          if (s.pending?.n === mark) s.pending = null;
        });
        return null;
      }
      if (!stillSize(deps, transcript, baseline)) {
        // The session moved: no later `idle_prompt` may post this mark either.
        await deps.update((s) => {
          if (s.pending?.n === mark) s.pending = null;
        });
        return null;
      }
      const after = deps.state();
      if (requestInCharge(after, deps.alive)) return null;
      const current = after?.pending;
      if (!current || current.n !== mark || current.posted) return null;
      // An approved tool that runs: a child of Claude Code that started after the prompt.
      const kids = await deps.children();
      const checkedAt = deps.now();
      if (kids && kids.some((child) => startedAfter(child, startedAt, checkedAt))) return null;
      const claimed = await deps.update((s) => {
        if (!s.pending || s.pending.n !== mark || s.pending.posted) return null;
        s.pending.posted = true;
        return { ...s.pending };
      });
      if (!claimed) return null;
      return postPermission(deps, link, claimed);
    }
    return null;
  } catch (err) {
    // A closed word for the throw (its class, never its message), so the
    // trace says which hook gave up (/dcr wave 1 finding 30): `request-threw`
    // for the 12-hour request hook.
    try {
      deps.trace?.(`${event}-threw`, err instanceof Error ? err.name : "error");
    } catch {
      // The trace is best effort.
    }
    return null;
  }
}

/** The first sign of the two kinds: the cheap synchronous ones, then the slow probe. */
async function anySign(io) {
  const sign = io.signs();
  if (sign) return sign;
  return io.probe ? await io.probe() : null;
}

/** The closed words a sign is traced with: `answered <sign>` for an answer at the terminal, else the sign alone. */
function signWords(io, sign) {
  return io.closeBy(sign) === "terminal" ? ["answered", sign] : [sign];
}

/**
 * THE REQUEST POST, with its retries: `waiting_permission` with the key, up
 * to `REQUEST_POST_TRIES` times on a status that a later try can fix (no
 * answer, a 401 while the watcher rotates the token, a 408, a 425, a 429, a
 * 5xx), honoring `retry-after`, with the same key (the server's insert is
 * idempotent by key), and the signs read before each try again. Anything but
 * `{ accepted: true }` is not accepted. A try with NO CLEAR ANSWER (none at
 * all, or a 5xx) may still have made the row, so when the post gives up
 * after one and no later try answered clearly, it closes the key: `terminal`
 * or `gone` by the sign that ended the tries (`io.closeBy`), `gone` when the
 * tries were spent. The door answers 404 for a key it does not know.
 */
async function postRequestRow(io, key, body) {
  let accepted = false;
  let mayHaveRow = false;
  let clear = false;
  let sign = null;
  let last = { status: 0, answer: null };
  for (let attempt = 1; attempt <= REQUEST_POST_TRIES; attempt += 1) {
    const res = await io.request({ ...body, requestKey: key });
    last = res;
    io.trace("request", res.status);
    if (res.status === 0 || res.status >= 500) mayHaveRow = true;
    if (res.status >= 200 && res.status < 300) {
      accepted = isRecord(res.answer) && res.answer.accepted === true;
      clear = true;
      break;
    }
    if (!transientStatus(res.status)) {
      clear = true;
      break;
    }
    if (attempt === REQUEST_POST_TRIES) break;
    await io.sleep(retryDelay(attempt, res.retryAfterMs));
    sign = await anySign(io);
    if (sign) break;
  }
  if (!accepted) {
    io.trace(...(sign ? ["not-accepted", ...signWords(io, sign)] : ["not-accepted"]));
    if (mayHaveRow && !clear) {
      const by = sign ? io.closeBy(sign) : "gone";
      io.trace(`close-${by}`, await io.action(key, { action: "close", by }));
    }
  }
  return { accepted, status: last.status, answer: last.answer ?? null, sign };
}

/**
 * THE WAIT FOR THE OWNER'S ANSWER, ONE COPY FOR EVERY HARNESS (/dcr wave 1
 * finding 61). The Claude Code request hook (`runRequest` below) and the
 * agent bridge's waiting hooks (`waitForOwner` in `bridge/bridge.mjs`) both
 * drive this loop, each with its own `io`: the requests, the signs, which
 * close a sign calls for. Until 2026-11-26 the bridge had its own copy of the
 * protocol, and a fix to one copy (the close of a lost-answer row, a 401 as a
 * transient failure, the retry of a push) missed the other.
 *
 * In order:
 *   1. The request post (`postRequestRow`). Not accepted ends it.
 *   2. The loop. The signs first (`io.signs`, then `io.probe`): any sign
 *      closes the row by `io.closeBy(sign)` and ends it.
 *   3. The deadline: no poll starts that could end after it (a poll may take
 *      its hold and `POLL_MARGIN_MS`); at the deadline the row closes as `gone`.
 *   4. The push, once, after `pushAfterMs` (the minute), when `io.mayPush`
 *      says so (the hook: no approved tool runs). A status that a later try
 *      can fix is tried again `retryDelay` later; any other answer ends the
 *      asking (/dcr wave 1 finding 9: the bridge asked once and dropped a
 *      lost push). The poll that holds across the push's time ends AT it.
 *   5. The long poll (`io.poll`), up to `POLL_WAIT_S` seconds, the signs read
 *      during it. `allowed` or `denied` is the take: the decision goes back to
 *      the caller, which prints it or closes the row as `terminal`. `closed`
 *      or `unknown` ends it, with ONE exception: a `closed` that follows a run
 *      of failed polls at least `PERMISSION_SWEEP_AFTER_MS` long can be the
 *      server's sweep (the hook could not stamp its poll), and the prompt is
 *      still up (no sign), so the prompt is posted again with a fresh key, at
 *      most once for each such gap (/dcr wave 1 finding 39: until then a
 *      two-minute network gap ended remote answers for a prompt the hook
 *      waits 12 hours on). The new request names the swept key (`replaces`), and
 *      the server resolves the swept row's entry as `session`, so the page
 *      draws one open row for the prompt.
 *   6. `open`: `io.openSign` may end it (the bridge: "I'm away" turned off).
 *      A poll that asked to wait and came back sooner than `QUICK_OPEN_MS`
 *      was not held (the server's cap of waiting polls for one account): the
 *      next poll waits 2, 4, 8, then 16 s (/dcr wave 1 finding 16). Else at
 *      least `POLL_MIN_GAP_MS` between two polls.
 *   7. A failed poll: a status that a later try can fix waits `retryDelay`
 *      (with `retry-after`); any other (a 403, a 404, a 400) ends it.
 *
 * @param {{
 *   now: () => number,
 *   sleep: (ms: number) => Promise<void>,
 *   trace: (...words: unknown[]) => void,
 *   request: (body: Record<string, unknown>) => Promise<{ status: number, answer?: unknown, retryAfterMs?: number | null }>,
 *   poll: (key: string, waitS: number) => Promise<{ status: number, answer?: unknown, retryAfterMs?: number | null, sign?: string }>,
 *   action: (key: string, body: Record<string, unknown>) => Promise<number | string>,
 *   signs: () => string | null,
 *   probe?: (() => Promise<string | null>) | null,
 *   mayPush?: () => Promise<boolean>,
 *   openSign?: (answer: Record<string, unknown>) => string | null,
 *   closeBy: (sign: string) => "terminal" | "gone",
 *   accepted?: (key: string) => Promise<unknown>,
 *   rekey?: (oldKey: string, newKey: string) => Promise<unknown>,
 *   randomKey: () => string,
 * }} io
 * @param {{ key: string, body: Record<string, unknown>, startedAt: number, deadline: number, pushAfterMs?: number }} plan
 * @returns {Promise<
 *   | { kind: "decision", key: string, answer: Record<string, unknown> }
 *   | { kind: "not-accepted", key: string, status: number, answer: unknown, sign: string | null }
 *   | { kind: "ended", key: string, why: string }
 * >}
 */
export async function askOwner(io, plan) {
  let key = plan.key;
  const posted = await postRequestRow(io, key, plan.body);
  if (!posted.accepted) return { kind: "not-accepted", key, status: posted.status, answer: posted.answer, sign: posted.sign };
  await io.accepted?.(key);
  const close = async (by) => {
    io.trace(`close-${by}`, await io.action(key, { action: "close", by }));
  };
  const endOn = async (sign) => {
    io.trace(...signWords(io, sign));
    await close(io.closeBy(sign));
    return /** @type {const} */ ({ kind: "ended", key, why: sign });
  };
  const pushAfter = plan.pushAfterMs ?? PERMISSION_PUSH_AFTER_MS;
  let pushed = false;
  // When the push is due: the minute, then `retryDelay` after each try that a later try can fix.
  let pushAt = plan.startedAt + pushAfter;
  let pushTries = 0;
  let failures = 0;
  let quick = 0;
  let lastOkAt = io.now();
  for (;;) {
    const sign = await anySign(io);
    if (sign) return endOn(sign);
    const left = plan.deadline - io.now();
    if (left < POLL_MARGIN_MS + 1000) {
      io.trace("deadline");
      await close("gone");
      return { kind: "ended", key, why: "deadline" };
    }
    if (!pushed && io.now() >= pushAt && (!io.mayPush || (await io.mayPush()))) {
      const status = await io.action(key, { action: "push" });
      io.trace("push", status);
      // Once. The server's claim is idempotent, so a status that a later try
      // can fix is tried again, `retryDelay` later (the poll before it is cut
      // short); "unreachable" is no answer. Any other answer ends the asking.
      pushed = !transientStatus(Number(status) || 0);
      if (!pushed) {
        pushTries += 1;
        pushAt = io.now() + retryDelay(pushTries);
      }
    }
    let waitS = Math.min(POLL_WAIT_S, Math.floor((left - POLL_MARGIN_MS) / 1000));
    if (!pushed) {
      // The poll that holds across the push's time ends AT that time.
      const toPush = pushAt - io.now();
      if (toPush > 0) waitS = Math.max(1, Math.min(waitS, Math.ceil(toPush / 1000)));
    }
    const began = io.now();
    const res = await io.poll(key, waitS);
    if (res.sign) return endOn(res.sign);
    if (res.status === 200) {
      const answer = isRecord(res.answer) ? res.answer : {};
      if (answer.state === "allowed" || answer.state === "denied") return { kind: "decision", key, answer };
      if (answer.state === "closed" && failures > 0 && io.now() - lastOkAt >= PERMISSION_SWEEP_AFTER_MS) {
        const late = await anySign(io);
        if (late) return endOn(late);
        const next = io.randomKey();
        io.trace("row", "swept", "request-again");
        await io.rekey?.(key, next);
        // `replaces` names the swept key, so the server resolves its entry and
        // the page draws one open row for this prompt.
        const again = await postRequestRow(io, next, { ...plan.body, replaces: key });
        key = next;
        if (!again.accepted) return { kind: "not-accepted", key, status: again.status, answer: again.answer, sign: again.sign };
        await io.accepted?.(key);
        // The server resolved the swept entry, and that acknowledged its bell
        // row: a prompt that had pushed asks for the new entry's push at once,
        // so the bell and the Agents count still say that it waits (/dcr
        // wave 2). One that had not pushed keeps its minute.
        if (pushed) {
          pushed = false;
          pushTries = 0;
          pushAt = io.now();
        }
        failures = 0;
        quick = 0;
        lastOkAt = io.now();
        continue;
      }
      if (answer.state === "closed" || answer.state === "unknown") {
        io.trace("row", answer.state);
        return { kind: "ended", key, why: String(answer.state) };
      }
      // "open", or a word this loop does not know: keep waiting.
      const stop = io.openSign?.(answer) ?? null;
      if (stop) return endOn(stop);
      failures = 0;
      // The server stamps `hook_polled_at` at the START of a poll (its first
      // check; the waiting rechecks are plain reads), so the gap that the
      // sweep measures starts there too (/dcr wave 2).
      lastOkAt = began;
      const spent = io.now() - began;
      if (spent < QUICK_OPEN_MS) {
        quick = Math.min(quick + 1, QUICK_BACKOFF_STEPS);
        await io.sleep(1000 * 2 ** quick);
      } else {
        quick = 0;
        if (spent < POLL_MIN_GAP_MS) await io.sleep(POLL_MIN_GAP_MS - spent);
      }
      continue;
    }
    io.trace("poll", res.status);
    // A 403 or a 404: the row or the session is gone for this bearer. A 400 too.
    if (!transientStatus(res.status)) return { kind: "ended", key, why: `poll-${res.status}` };
    failures += 1;
    await io.sleep(retryDelay(failures, res.retryAfterMs));
  }
}

/**
 * THE REQUEST HOOK (PermissionRequest, design section 7). In order:
 *   1. D3: a reply tool of the user's own PasserJack server for this session
 *      is approved at once, with no rules added (every call is checked again).
 *   2. No part (no output, the dialog decides): no link (no watcher, a `-p`
 *      run), a mode with no dialog, a tool name the server cannot take
 *      (`TOOL_RE`: the page must say which tool gets the input, /dcr wave 1
 *      finding 68), a tool whose Allow needs an answer PasserJack cannot give,
 *      no input to show, a bearer with no remote answers (D8: an environment
 *      key that the watcher did not prove to be the saved sign-in's account),
 *      no token, Claude Code gone, or no hooks' state.
 *   3. An entry in the hooks' state at once (so a quick finish clears it),
 *      with the call's digest (`callText`), then the 2 s settle, then the
 *      call's `tool_use_id` from the transcript. A prompt answered in the
 *      settle never reaches the page.
 *   4. The request row (`askOwner`): `waiting_permission` with a random
 *      `requestKey` (in memory only), the tool, the input as `shownInput`
 *      makes it, and the session grant (`sessionGrantOf`).
 *   5. The wait (`askOwner`), with the terminal signs read during it and
 *      after each answer: Claude Code gone, the hooks' entry cleared (its own
 *      finished or failed call, a typed prompt, a Stop with no live
 *      background work, a session start that is not a compaction), the
 *      request counter moved, the call's result in the transcript, or (for a
 *      Bash call) its shell running (`shellCallRuns`, finding 64). Any of
 *      them closes the row as `terminal`. The watcher's link gone (or naming
 *      another session) closes it as `gone`. While the call has no
 *      `tool_use_id`, the transcript is read again when it grows, and the id
 *      is taken when the call's line (same name AND input) lands. After a
 *      minute with no sign, and no child of Claude Code that started after
 *      the prompt, it asks for the push.
 *   6. The owner's answer: the signs are read once more, and D8 once more
 *      (the link must still carry this bearer's mark). When either says no,
 *      the decision is NOT printed and the row closes as `terminal`
 *      (the server then re-resolves the taken row: the page says the prompt
 *      was answered at the terminal, never "Allowed here" for a decision that
 *      decided nothing). Else Allow (with the hook's OWN grant entries for
 *      "Allow for this session") or Deny with the owner's note.
 *   7. It stops `REQUEST_STOP_EARLY_MS` (or one poll) before Claude Code's
 *      timeout and closes the row as `gone`.
 * A terminal "No" that interrupts the turn KILLS this process (proven live):
 * the next prompt's `working` and the server's sweep close its row. A
 * terminal Yes on a tool that is not Bash gives no sign until the tool ends
 * (proven live for Bash; finding 64): until then the row stays answerable.
 */
async function runRequest(input, deps, startedAt, transcript) {
  const trace = deps.trace ?? (() => {});
  const first = deps.link();
  if (replyToolApproved(input, first)) {
    trace("reply-allowed");
    return allowOutput();
  }
  if (!first) return null;
  if (NO_DIALOG_MODES.includes(/** @type {string} */ (input.permission_mode))) {
    trace("no-dialog");
    return null;
  }
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  if (!TOOL_RE.test(tool)) {
    trace("bad-tool");
    return null;
  }
  if (NEEDS_INPUT_TOOLS.includes(tool)) {
    trace("needs-input");
    return null;
  }
  const shown = shownInput(tool, input.tool_input);
  if (!shown) {
    trace("no-input");
    return null;
  }
  if (!deps.remote(first)) return null;
  const alive = () => !deps.claudeAlive || deps.claudeAlive();
  if (!alive()) {
    trace("claude-gone");
    return null;
  }

  const requestTurn = deps.state()?.requestTurn ?? null;
  const call = callDigestOf(deps, tool, input.tool_input);
  const n = await deps.update((s) => {
    s.requests = s.requests.filter((r) => !deps.alive || deps.alive(r.pid));
    s.marks += 1;
    s.requests.push({ n: s.marks, pid: deps.pid, toolUseId: null, call, accepted: false });
    return s.marks;
  });
  // No hooks' state: the signs could not be read, so take no part.
  if (n === null) {
    trace("no-state");
    return null;
  }
  const drop = () =>
    deps.update((s) => {
      s.requests = s.requests.filter((r) => r.n !== n);
    });
  /** Write the call's id into this hook's entry, once it is known. */
  const keepId = (id) =>
    deps.update((s) => {
      const mine = s.requests.find((r) => r.n === n);
      if (mine && mine.toolUseId === null) mine.toolUseId = id;
    });

  await deps.sleep(REQUEST_SETTLE_MS);
  let toolUseId = transcript ? pendingCallFor(deps.tail(transcript), tool, input.tool_input) : null;
  if (toolUseId) await keepId(toolUseId);

  let seenSize = null;
  /**
   * Why the prompt is no longer up, or this hook can no longer answer it, or
   * null. Synchronous and cheap: a file read, a stat, a kill(0).
   * `LINK_GONE` (the watcher stopped, or its link names another session) is
   * read here too, so a held poll ends at the next tick and the row closes as
   * `gone` at once: the page stops offering a prompt that this hook would
   * no longer print an answer for (it checks the link before any print).
   */
  const signs = () => {
    if (!alive()) return "claude-gone";
    const now = deps.link();
    if (!now || now.sessionId !== first.sessionId) return LINK_GONE;
    const s = deps.state();
    if (!s) return null;
    if (requestTurn !== null && (s.requestTurn ?? 0) !== requestTurn) return "turn";
    if (!s.requests.some((r) => r.n === n)) return "cleared";
    if (transcript) {
      const size = deps.size(transcript);
      if (size !== null && size !== seenSize) {
        seenSize = size;
        const tail = deps.tail(transcript);
        if (!toolUseId) {
          // The call's line landed late (/dcr wave 1 finding 8): take its id
          // now, by name AND input, so another call's finish never reads as
          // this one's.
          const found = pendingCallFor(tail, tool, input.tool_input);
          if (found) {
            toolUseId = found;
            void keepId(found);
          }
        }
        if (toolUseId && hasToolResult(tail, toolUseId)) return "result";
      }
    }
    return null;
  };
  // THE SHELL OF THIS CALL (finding 64): only for Bash, the one tool whose
  // approved call is proven to run as `eval '<command>'`.
  const command = tool === EVAL_SHELL_TOOL && isRecord(input.tool_input) && typeof input.tool_input.command === "string" ? input.tool_input.command : null;
  const pattern = command !== null ? shellEvalPattern(command) : null;
  const probe =
    pattern && deps.childCommands
      ? async () => {
          const runs = shellsOfCall(await deps.childCommands(), pattern, startedAt, deps.now());
          if (!runs.length) return null;
          // One shell closes one row. No hooks' state (the lock failed): the
          // sign as it was, on the command alone.
          const mine = await deps.update((s) => claimShell(s, n, runs, deps.alive));
          return mine === false ? null : "shell-runs";
        }
      : null;

  /** @type {Parameters<typeof askOwner>[0]} */
  const io = {
    now: deps.now,
    sleep: deps.sleep,
    trace,
    request: (body) => deps.request(first, body),
    poll: (key, waitS) => deps.poll(first, key, signs, waitS, probe),
    action: (key, body) => deps.action(first, key, body),
    signs,
    probe,
    // An approved tool that runs: a child of Claude Code that started after the prompt.
    mayPush: async () => {
      const kids = await deps.children();
      const checkedAt = deps.now();
      return !(kids && kids.some((child) => startedAfter(child, startedAt, checkedAt)));
    },
    closeBy: (sign) => (sign === LINK_GONE ? "gone" : "terminal"),
    accepted: () =>
      deps.update((s) => {
        const mine = s.requests.find((r) => r.n === n);
        if (mine) mine.accepted = true;
      }),
    randomKey: deps.randomKey,
  };

  const settled = await anySign(io);
  if (settled) {
    trace("answered-in-settle", settled);
    await drop();
    return null;
  }

  // The request row. The key is in this process's memory and nowhere else.
  const grant = shown.inputTooLong ? null : sessionGrantOf(input.permission_suggestions);
  if (!grant && !shown.inputTooLong && grantTooLong(input.permission_suggestions)) trace("grant-too-long");
  const body = { state: "waiting_permission", tool };
  if (shown.toolInput !== null) body.toolInput = shown.toolInput;
  if (shown.inputTooLong) body.inputTooLong = true;
  if (grant) body.sessionGrant = grant.json;
  const out = await askOwner(io, {
    key: deps.randomKey(),
    body,
    startedAt,
    deadline: startedAt + REQUEST_TIMEOUT_S * 1000 - REQUEST_STOP_EARLY_MS,
  });
  if (out.kind !== "decision") {
    await drop();
    return null;
  }

  // THE TAKE. The terminal signs again, and D8 again (the watcher may have
  // taken the mark out of the link during a wait of up to 12 hours), right
  // before the decision is printed. When either says no, nothing is printed,
  // and the row closes as `terminal`: the server re-resolves the taken row,
  // so the page says the prompt was answered at the terminal, and never that
  // the owner's decision decided it (contract of 2026-11-26).
  const answer = out.answer;
  let refused = await anySign(io);
  await drop();
  if (refused) trace("answered-before-print", refused);
  else {
    const now = deps.link();
    if (!now || now.sessionId !== first.sessionId || !deps.remote(now)) {
      refused = "no-remote";
      trace("no-remote-at-answer");
    }
  }
  if (refused) {
    trace("close-terminal", await deps.action(first, out.key, { action: "close", by: "terminal" }));
    return null;
  }
  trace(answer.state === "allowed" ? "decided-allow" : "decided-deny", answer.scope === "session" ? "session" : "once");
  if (answer.state === "denied") return denyOutput(answer.note);
  return allowOutput(answer.scope === "session" && grant ? grant.apply : null);
}

/**
 * Post one claimed permission mark; a failed post gives the claim back, so
 * `idle_prompt` may try again. Nothing is posted when Claude Code or its
 * watcher has exited in the minute (`claudeAlive`, and the link read again,
 * which checks the watcher): a prompt of a closed session must not push
 * (/dcr wave 2).
 */
async function postPermission(deps, claimedLink, mark) {
  const link = deps.claudeAlive && !deps.claudeAlive() ? null : deps.link();
  if (!link || link.sessionId !== claimedLink.sessionId) return null;
  const body = { state: "waiting_permission" };
  if (mark.tool) body.tool = mark.tool;
  if (await deps.post(link, body)) return "waiting_permission";
  await deps.update((s) => {
    if (s.pending?.n === mark.n) s.pending.posted = false;
  });
  return null;
}

/**
 * NOT CLAUDE CODE: Grok Build loads Claude Code plugin hooks too (it lists this
 * plugin in `grok inspect`), and hands them its own camelCase payload. A Grok
 * session gets the agent bridge's own hooks from its setup page, so these
 * hooks stay silent there: `GROK_SESSION_ID` in the environment, or a
 * `hookEventName` field (Claude Code never sends one), means another harness.
 */
export function notClaudeCode(env, input) {
  if ((env.GROK_SESSION_ID ?? "").trim() !== "") return true;
  return Boolean(input && typeof input === "object" && "hookEventName" in input);
}
