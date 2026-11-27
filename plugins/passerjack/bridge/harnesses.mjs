/**
 * THE HARNESS ADAPTERS: one entry per agent program whose hooks run the
 * PasserJack bridge (`bridge.mjs`). Pure: no file, no network, no clock. Each
 * entry says which of the program's events (its hook's stdin JSON) the bridge
 * listens to, how to
 * read the session id, the folder, the last message and the tool name out of
 * the payload, and how to answer with that program's own documented "keep
 * going" decision.
 *
 * EVERY FIELD NAME BELOW WAS READ FROM THE PROGRAM'S OWN DOCUMENTATION on
 * 2026-11-25 (the survey is in `docs/plans/2026-11-25-agents-ui/harnesses.html`,
 * with a link per program). `tests/unit/agent-bridge-harnesses.test.ts` feeds
 * each adapter the documented sample payload and pins the decision it prints.
 *
 * WHITELIST, NEVER SPREAD. An adapter copies the few fields it needs and
 * nothing else: a payload can carry a tool's input (a command, a file's
 * text), the user's e-mail address (Cursor). None of that leaves this module,
 * with two exceptions:
 *   - the TRANSCRIPT PATH, kept so that a waiter can tell that the session
 *     moved during its minute: the bridge reads that file's SIZE only, never
 *     its content, and the path stays in the 0600 state file on this computer;
 *   - the TOOL INPUT of a permission prompt (`input`, design D1 of
 *     `docs/plans/2026-11-26-remote-permission/design.html`), for a harness
 *     whose prompt the owner can answer from PasserJack (`answers`). It goes
 *     ONLY into the body of the one request post (`POST
 *     /api/sessions/<id>/state` with a `requestKey`), from the memory of the
 *     process that waits for the answer. It never goes into the state file, a
 *     worker's argv, a trace word or any other request. An input of more than
 *     `MAX_TOOL_INPUT_CHARS` characters is NEVER cut: the event carries no
 *     input and `inputTooLong`, so the server offers Deny only. A cut command
 *     that the owner allowed would run a part that the owner did not see.
 *
 * DEPENDENCY-FREE, like the rest of the plugin: Node 18+. Its one import is
 * the Claude Code plugin's `../bin/hook-core.mjs`, for the rules the bridge
 * must apply exactly as the plugin does: the tool-name shape, the cut of a
 * last message, what the owner sees of a tool's input (`shownInput`, with
 * each harness's own shell tools), and the words of a Deny (`denyMessage`).
 * ONE COPY of each: a Codex session and a Claude Code session read the same
 * Deny words, and see an input by the same rule.
 */

import { clipText, denyMessage, LIVE_TASK_STATES, MAX_SENT_CHARS, shellCommandOf, shownInput, TOOL_RE } from "../bin/hook-core.mjs";

/** What the bridge does with a normalized event. */
export const BRIDGE_EVENTS = ["session_start", "prompt", "turn_end", "permission", "question", "resolved", "reply_refused", "session_end", "last_text", "wake", "delivered"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A session id or a conversation id: one line of printable characters, at most 200. */
const KEY_RE = /^[\x21-\x7e]{1,200}$/;

/**
 * The longest last message the bridge keeps from a payload: the plugin's
 * `MAX_SENT_CHARS` (9000), MORE than the server's 8000 on purpose, so the
 * server cuts it, marks the cut (`CUT_MARKER`) and logs it.
 */
export const MAX_LAST_MESSAGE_CHARS = MAX_SENT_CHARS;

const str = (value) => (typeof value === "string" && value.length > 0 ? value : null);

/** A session key, or null when it is not a short printable id. */
export function sessionKeyOf(value) {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : str(value);
  return text && KEY_RE.test(text) ? text : null;
}

/** A tool name the server accepts, or null. Never the tool's input. */
export function toolNameOf(value) {
  const text = str(value);
  return text && TOOL_RE.test(text) ? text : null;
}

/** The last message, clipped as the plugin clips it (`clipText`), or null for nothing. */
export function lastMessageOf(value) {
  const text = str(value);
  if (!text || !text.trim()) return null;
  return clipText(text);
}

/*
 * THE TOOL INPUT OF A PERMISSION PROMPT is `shownInput` of
 * `../bin/hook-core.mjs`, the ONE rule (/dcr wave 1 findings 62 and 66): the
 * bare command only for the harness's own shell tool (`shellTools` on each
 * adapter, the names its documentation gives) whose other fields are all on
 * the closed plain list, and EVERY other shape as compact JSON, so the owner
 * sees every field. Until 2026-11-26 this module showed the `command` field
 * alone for ANY tool: an MCP tool with `{ command, target }` showed `command`,
 * and an Allow ran `target` too. Over `MAX_TOOL_INPUT_CHARS` code points it is
 * never cut. A tool name that no list holds shows as JSON.
 */

/** No shell tool: every input shows as JSON. */
const NO_SHELL_TOOLS = Object.freeze([]);

/**
 * Codex's shell tools: "`Bash` and `apply_patch` use `tool_input.command`
 * while MCP tools send all the arguments" (the Codex hooks reference, read
 * 2026-11-25).
 */
const CODEX_SHELL_TOOLS = Object.freeze(["Bash", "apply_patch"]);
/** Copilot CLI's: the runtime names `bash` and `powershell`, reported as `Bash` in a PascalCase payload (its hooks reference). */
const COPILOT_SHELL_TOOLS = Object.freeze(["bash", "powershell", "Bash"]);
/** Junie's: the tool category `Bash` (its `apply_patch` carries a `patch`, so it shows as JSON). */
const JUNIE_SHELL_TOOLS = Object.freeze(["Bash"]);
/** Devin's: `exec` (its hooks overview's example). */
const DEVIN_SHELL_TOOLS = Object.freeze(["exec"]);
/** opencode's: the `bash` permission, whose `metadata` carries the `command`. */
const OPENCODE_SHELL_TOOLS = Object.freeze(["bash"]);

/**
 * What the owner sees of a tool's input, `shownInput`'s answer in this
 * module's words: `{ input, tooLong }`, with `input` null when there is
 * nothing to show (then the bridge takes no part) and `tooLong` true for an
 * input over `MAX_TOOL_INPUT_CHARS` that is never cut.
 *
 * @param {unknown} value
 * @param {unknown} [toolName]
 * @param {readonly string[]} [shellTools]
 */
export function toolInputOf(value, toolName = null, shellTools = NO_SHELL_TOOLS) {
  const shown = shownInput(toolName, value, shellTools);
  return { input: shown?.toolInput ?? null, tooLong: shown?.inputTooLong ?? false };
}

/** A request id that a shim sends (opencode's `permission.asked` `id`): one printable line of at most 200 characters, or null. */
function requestIdOf(value) {
  const text = str(value);
  return text && KEY_RE.test(text) ? text : null;
}

function firstString(list) {
  return Array.isArray(list) ? (list.find((entry) => typeof entry === "string" && entry.length > 0) ?? null) : null;
}

/**
 * The normalized event. `sessionKey` is the harness's own session id (null
 * when the event carries none: Junie's Stop). `stopActive` is true when the
 * harness says this turn was already continued by a stop hook, and
 * `loopCount` is Cursor's count of earlier follow-ups: both reset the bridge's
 * per-turn delivery count when they say "a fresh turn". `confirm` is a shim
 * that says whether its program took the text (opencode: a prompt can fail),
 * and `ids` and `ok` are that answer (`delivered`).
 *
 * A permission prompt also carries `input` and `inputTooLong` (`toolInputOf`
 * of the raw `input` with the adapter's `shellTools`: what the owner sees, or
 * none and `inputTooLong` when it is too long),
 * `sandboxBypass` (Copilot's request to leave the sandbox, where an allow
 * from a hook does not skip the prompt), and for a shim `requestId` (the
 * program's own id of the prompt) and `answer` (the shim waits for the
 * owner's answer: `opencode-plugin.js`).
 */
function ev(event, fields) {
  const toolInput =
    fields.shown ?? (fields.input === undefined ? { input: null, tooLong: false } : toolInputOf(fields.input, fields.tool, fields.shellTools ?? NO_SHELL_TOOLS));
  return {
    event,
    sessionKey: fields.sessionKey ?? null,
    cwd: str(fields.cwd),
    lastMessage: fields.lastMessage === undefined ? null : lastMessageOf(fields.lastMessage),
    tool: fields.tool === undefined ? null : toolNameOf(fields.tool),
    stopActive: fields.stopActive === true,
    loopCount: typeof fields.loopCount === "number" ? fields.loopCount : null,
    busyBackground: fields.busyBackground === true,
    transcript: transcriptOf(fields.transcript),
    confirm: fields.confirm === true,
    ids: Array.isArray(fields.ids) ? fields.ids.filter((id) => typeof id === "string" && UUID_RE.test(id)).slice(0, 50).map((id) => id.toLowerCase()) : [],
    ok: fields.ok === true,
    input: toolInput.input,
    inputTooLong: toolInput.tooLong,
    sandboxBypass: fields.sandboxBypass === true,
    requestId: fields.requestId === undefined ? null : requestIdOf(fields.requestId),
    answer: fields.answer === true,
    // `resolved`: who closed the prompt. `session` is the harness itself
    // (opencode's reject of every other open prompt after the owner's Deny on
    // one); anything else is the person at the terminal.
    closer: fields.by === "session" ? "session" : null,
  };
}

/** An absolute transcript path, or null. Only its size is ever read. */
function transcriptOf(value) {
  const text = str(value);
  return text && text.length <= 4096 && (text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text)) ? text : null;
}

const json = (value) => JSON.stringify(value);

/** `{"decision":"block","reason":...}`: Codex, Grok Build, Copilot, Goose, Junie, Devin, Continue. */
const blockDecision = (text) => json({ decision: "block", reason: text });

/**
 * THE PERMISSION ANSWERS FROM PASSERJACK (design
 * `docs/plans/2026-11-26-remote-permission/design.html`, sections 3 and 8).
 * `answers` on a harness is its tier, the same word as `PERMISSION_ANSWERS`
 * of `src/lib/agent-conversation-rules.ts` for its `reported` key:
 *   - `always`: the prompt stays live at the terminal while the shim waits
 *     for the owner (opencode).
 *   - `away`: the program runs its permission hook BEFORE it shows the
 *     prompt, so the hook waits only while the owner's "I'm away" switch is
 *     on (Codex, Copilot CLI, Junie, Devin). With the switch off, the hook
 *     makes ONE read and answers "no decision" at once.
 *   - `never`: no answer from PasserJack (every other program, and Kilo Code
 *     until a live walk proves its reply).
 * `permissionEvent` is the program's own name of the event whose output is
 * the decision, and `permissionOut` builds that output: `{ stdout, code }`,
 * because Junie needs an exit code that is not 0.
 *
 * Copilot CLI, Junie and Devin are pinned to their documentation here, but
 * the setup script does NOT install their permission hook, and the server's
 * table has them `never`, until a live walk proves each one.
 */
const hookOut = (stdout, code = 0) => ({ stdout, code });

/** Codex PermissionRequest. NEVER `updatedInput`, `updatedPermissions` or `interrupt`: "reserved for future behavior and fail closed today". */
const codexPermission = {
  allow: () => hookOut(json({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } })),
  deny: (message) => hookOut(json({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message } } })),
  // "If no matching hook decides, Codex uses the normal approval flow." An empty stdout with exit 0 decides nothing.
  none: () => hookOut(""),
};

/** Copilot CLI permissionRequest: `behavior` and `message`. NEVER `interrupt`. "Return empty output or {} to fall through." */
const copilotPermission = {
  allow: () => hookOut(json({ behavior: "allow" })),
  deny: (message) => hookOut(json({ behavior: "deny", message })),
  none: () => hookOut(""),
};

/**
 * Junie PermissionRequest. DANGER: "A hook that exits successfully (exit code
 * 0) without a blocking decision automatically approves the action." So the
 * allow IS an exit 0 with no output, and "no decision" is a non-zero exit
 * other than 2: Junie "falls back to showing the normal permission dialog".
 */
const juniePermission = {
  allow: () => hookOut("", 0),
  deny: (message) => hookOut(json({ decision: "deny", reason: message })),
  none: () => hookOut("", 1),
};

/**
 * Devin PermissionRequest: `decision` `approve` or `block`. "No decision" is
 * the exit 0 with no output of the documentation's own example
 * (`... else sys.exit(0)`): no sentence states it, so it is UNVERIFIED.
 */
const devinPermission = {
  allow: () => hookOut(json({ decision: "approve" })),
  deny: (message) => hookOut(json({ decision: "block", reason: message })),
  none: () => hookOut(""),
};

/**
 * A shim's answer (`opencode-plugin.js` replies out of band): `once` or
 * `reject`, NEVER `always`. A `reject` in opencode also rejects every other
 * open prompt of that session (`permission/index.ts` of v1.18.14), and the
 * plugin reports those as closed by the session (`permission_replied` with
 * `by: "session"`).
 */
const shimPermission = {
  allow: () => hookOut(json({ reply: "once" })),
  deny: (message) => hookOut(json(message ? { reply: "reject", message } : { reply: "reject" })),
  none: () => hookOut(""),
};

/**
 * THE HOOK TIMEOUT of a waiting-first permission hook, in seconds: the one
 * that the setup script installs for Codex's PermissionRequest (`install.cjs`
 * writes this number; `tests/unit/agent-bridge-setup.test.ts` pins the two).
 * An hour (builder's reading): the owner who turned on "I'm away" can answer
 * an hour later, and while the hook waits Codex shows no prompt, so a person
 * at the terminal turns "I'm away" off and the hook stops within one poll.
 * Codex documents a default of 600 seconds and no maximum: that it honours an
 * hour is UNVERIFIED until a live walk.
 */
export const AWAY_HOOK_TIMEOUT_S = 3600;

/** A waiting hook stops this long before its harness's timeout, so it closes its request itself. */
export const PERMISSION_WAIT_MARGIN_MS = 30_000;

/**
 * The longest a shim's waiter waits (opencode keeps a prompt open with no
 * timeout). Twelve hours, the target of the Claude Code plugin's own hook.
 */
export const SHIM_PERMISSION_WAIT_MS = 12 * 60 * 60_000;

/** The waiting-first tier's wait: the installed timeout less the margin. */
const AWAY_WAIT_MS = AWAY_HOOK_TIMEOUT_S * 1000 - PERMISSION_WAIT_MARGIN_MS;

/**
 * The background task states that mean the work is over. Any OTHER status, or
 * none, counts as live work (/dcr wave 2): a Grok build whose payload has no
 * status, or a word this table does not know, would otherwise read as no
 * work, post `idle` while the work runs and release a held question push.
 * The cautious side costs nothing: a held question still reaches the phone
 * from the server's grace push (`agents-page.md`, PUSH).
 */
const DONE_TASK_STATES = new Set(["completed", "complete", "done", "finished", "succeeded", "success", "failed", "failure", "error", "errored", "cancelled", "canceled", "killed", "stopped", "exited", "terminated", "timed_out", "timeout"]);

/**
 * A LIVE background task that is NOT the PasserJack monitor: the session
 * waits on that work (it wakes the agent when it ends), not on the user. Live
 * by its status: a known live word (`LIVE_TASK_STATES`, as the Claude Code
 * plugin's `waitsOnWork` reads it), or any status that is not a known word
 * for work that is over (`DONE_TASK_STATES`).
 */
function hasOtherBackgroundWork(tasks) {
  if (!Array.isArray(tasks)) return false;
  return tasks.some((task) => {
    if (!task || typeof task !== "object") return false;
    const status = typeof task.status === "string" ? task.status.trim().toLowerCase() : "";
    if (!LIVE_TASK_STATES.has(status) && DONE_TASK_STATES.has(status)) return false;
    const text = `${task.description ?? ""} ${task.command ?? ""}`;
    return !/passerjack|bridge\.mjs/i.test(text);
  });
}

/**
 * EVERY HARNESS. `reported` is the `harness` the session registers with (at
 * most 32 characters, `agent-session-rules.ts`). `deliver` names how a turn
 * end hands the owner's message on: `decision` (the hook prints the
 * continue decision), `shim` (a plugin in the program reads the bridge's
 * `{"deliver": ...}` answer and starts the turn itself) or `none` (the
 * program has no way to continue a turn from a hook). `ride` is true when the
 * program adds a prompt hook's output to the prompt the user just sent, so an
 * owner message that waited reaches the model with the user's next line.
 * `cap` is how many continuations the bridge gives one turn, never more than
 * the program's own limit.
 */
export const HARNESSES = {
  codex: {
    label: "Codex",
    reported: "codex",
    // Stop: "JSON on stdout ... Plain text output is invalid for this event."
    silent: "",
    deliver: "decision",
    ride: true,
    cap: 3,
    // Codex awaits its permission hooks BEFORE it asks the person
    // (codex-rs/core/src/tools/approvals.rs:602-627): the hook waits only
    // while the owner is away. An allow is ignored when the action requires
    // a human approval (approvals.rs:611).
    answers: "away",
    permissionEvent: "PermissionRequest",
    permissionOut: codexPermission,
    permissionWaitMs: AWAY_WAIT_MS,
    events: {
      SessionStart: (j) => ev("session_start", { sessionKey: sessionKeyOf(j.session_id), cwd: j.cwd }),
      UserPromptSubmit: (j) => ev("prompt", { sessionKey: sessionKeyOf(j.session_id), cwd: j.cwd }),
      Stop: (j) =>
        ev("turn_end", {
          sessionKey: sessionKeyOf(j.session_id),
          cwd: j.cwd,
          lastMessage: j.last_assistant_message,
          stopActive: j.stop_hook_active,
          transcript: j.transcript_path,
        }),
      // With no decision printed: "decline to decide and let the normal
      // approval prompt continue". `tool_input`: "`Bash` and `apply_patch` use
      // `tool_input.command` while MCP tools send all the arguments".
      PermissionRequest: (j) =>
        ev("permission", {
          sessionKey: sessionKeyOf(j.session_id),
          cwd: j.cwd,
          tool: j.tool_name,
          transcript: j.transcript_path,
          input: j.tool_input,
          shellTools: CODEX_SHELL_TOOLS,
        }),
      SessionEnd: (j) => ev("session_end", { sessionKey: sessionKeyOf(j.session_id), cwd: j.cwd }),
      // NO `notify` adapter: Codex ignores notify's stdout, so a turn end there
      // can never continue the turn, and recording an owner message as
      // delivered there would lose it. The hooks in hooks.json do it all.
    },
    turnEnd: blockDecision,
    prompt: (text) => json({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }),
  },

  gemini: {
    label: "Gemini CLI",
    reported: "gemini-cli",
    // "Your script must not print any plain text to stdout other than the final JSON object."
    silent: "{}",
    deliver: "decision",
    ride: true,
    cap: 3,
    events: {
      SessionStart: (j) => ev("session_start", { sessionKey: sessionKeyOf(j.session_id), cwd: j.cwd }),
      BeforeAgent: (j) => ev("prompt", { sessionKey: sessionKeyOf(j.session_id), cwd: j.cwd }),
      AfterAgent: (j) =>
        ev("turn_end", {
          sessionKey: sessionKeyOf(j.session_id),
          cwd: j.cwd,
          lastMessage: j.prompt_response,
          stopActive: j.stop_hook_active,
          transcript: j.transcript_path,
        }),
      Notification: (j) =>
        j.notification_type === "ToolPermission"
          ? ev("permission", {
              sessionKey: sessionKeyOf(j.session_id),
              cwd: j.cwd,
              tool: j.details && typeof j.details === "object" ? (j.details.tool_name ?? j.details.toolName ?? j.details.name) : null,
              transcript: j.transcript_path,
            })
          : null,
      SessionEnd: (j) => ev("session_end", { sessionKey: sessionKeyOf(j.session_id), cwd: j.cwd }),
    },
    // AfterAgent: "decision: deny ... reason ... is sent to the agent as a new prompt".
    turnEnd: (text) => json({ decision: "deny", reason: text }),
    prompt: (text) => json({ hookSpecificOutput: { hookEventName: "BeforeAgent", additionalContext: text } }),
  },

  grok: {
    label: "Grok Build",
    reported: "grok-build",
    silent: "",
    // Its monitor may start with no GROK_SESSION_ID: SessionStart leaves an
    // alias on the processes above the hook, and the watch looks above itself.
    aliasByAncestor: true,
    deliver: "decision",
    // "stdout of an allowing hook is discarded (no additionalContext)" on UserPromptSubmit.
    ride: false,
    cap: 3,
    events: {
      SessionStart: (j) => (j.subagentType ? null : ev("session_start", grokKey(j))),
      UserPromptSubmit: (j) => (j.subagentType ? null : ev("prompt", grokKey(j))),
      Stop: (j) => {
        // A separate Stop fires at session end ("channel_closed" or "shutdown"):
        // its decision is ignored, and it is not a turn that waits on anybody.
        if (j.subagentType || (j.reason !== undefined && j.reason !== "end_turn")) return null;
        return ev("turn_end", {
          ...grokKey(j),
          lastMessage: j.lastAssistantMessage ?? j.last_assistant_message,
          stopActive: j.stopHookActive ?? j.stop_hook_active,
          busyBackground: hasOtherBackgroundWork(j.backgroundTasks ?? j.background_tasks),
        });
      },
      Notification: (j) => {
        if (j.subagentType) return null;
        const type = j.notificationType ?? j.notification_type;
        return type === "permission_prompt" ? ev("permission", grokKey(j)) : null;
      },
      SessionEnd: (j) => (j.subagentType ? null : ev("session_end", grokKey(j))),
    },
    turnEnd: blockDecision,
  },

  cursor: {
    label: "Cursor",
    reported: "cursor",
    silent: "",
    deliver: "decision",
    ride: false,
    // `loop_limit` defaults to 5 for Cursor hooks.
    cap: 3,
    events: {
      sessionStart: (j) => cursorEvent("session_start", j),
      beforeSubmitPrompt: (j) => cursorEvent("prompt", j),
      // The final text comes in its own event, before `stop`.
      afterAgentResponse: (j) => cursorEvent("last_text", j, { lastMessage: j.text }),
      stop: (j) => (j.status === "completed" ? cursorEvent("turn_end", j, { loopCount: j.loop_count }) : null),
      sessionEnd: (j) => cursorEvent("session_end", j),
    },
    // "followup_message ... auto-submits as next user msg".
    turnEnd: (text) => json({ followup_message: text }),
  },

  copilot: {
    label: "GitHub Copilot",
    reported: "copilot",
    silent: "",
    deliver: "decision",
    // "Command and HTTP config-file userPromptSubmitted hooks have their output dropped".
    ride: false,
    cap: 3,
    // permissionRequest "fires before the permission service runs (rules
    // engine, session approvals, auto-allow/auto-deny, and user prompting)".
    // NOT INSTALLED: it also fires for a call that the rules would allow at
    // once, so with "I'm away" on every such call would wait for the owner.
    // A live walk must prove which calls it fires for before the setup script
    // adds it.
    answers: "away",
    permissionEvent: "permissionRequest",
    permissionOut: copilotPermission,
    permissionWaitMs: AWAY_WAIT_MS,
    // With no answer from PasserJack, permissionRequest posts nothing: the
    // `permission_prompt` notification posts the prompt the old way.
    permissionLegacy: false,
    events: {
      sessionStart: (j) => ev("session_start", copilotKey(j)),
      userPromptSubmitted: (j) => ev("prompt", copilotKey(j)),
      agentStop: (j) => ev("turn_end", { ...copilotKey(j), stopActive: j.stop_hook_active }),
      notification: (j) => {
        const type = j.notification_type ?? j.notificationType;
        if (type === "permission_prompt") return ev("permission", copilotKey(j));
        if (type === "elicitation_dialog") return ev("question", copilotKey(j));
        return null;
      },
      // The input's field name is UNVERIFIED: the documentation gives none for
      // this event (`toolArgs` on preToolUse, `toolInput` in the sandbox text,
      // `tool_input` in the VS Code form), so the adapter takes the first one.
      permissionRequest: (j) => {
        const input = copilotArgs(j.toolArgs ?? j.toolInput ?? j.tool_input);
        return ev("permission", {
          ...copilotKey(j),
          tool: j.toolName ?? j.tool_name,
          input,
          shellTools: COPILOT_SHELL_TOOLS,
          // "a hook `allow` does not pre-approve the request or short-circuit the user prompt".
          sandboxBypass: Boolean(input && typeof input === "object" && input.requestSandboxBypass === true),
        });
      },
      sessionEnd: (j) => ev("session_end", copilotKey(j)),
    },
    turnEnd: blockDecision,
  },

  goose: {
    label: "Goose",
    reported: "goose",
    silent: "",
    deliver: "decision",
    ride: false,
    cap: 3,
    events: {
      SessionStart: (j) => ev("session_start", { sessionKey: sessionKeyOf(j.session_id), cwd: j.working_dir }),
      UserPromptSubmit: (j) => ev("prompt", { sessionKey: sessionKeyOf(j.session_id), cwd: j.working_dir }),
      Stop: (j) =>
        ev("turn_end", { sessionKey: sessionKeyOf(j.session_id), cwd: j.working_dir, lastMessage: j.last_assistant_message }),
      SessionEnd: (j) => ev("session_end", { sessionKey: sessionKeyOf(j.session_id), cwd: j.working_dir }),
    },
    turnEnd: blockDecision,
  },

  junie: {
    label: "Junie CLI",
    reported: "junie",
    silent: "",
    deliver: "decision",
    ride: false,
    cap: 3,
    // Stop carries "only hook_event_name, stop_hook_active, last_assistant_message".
    aliasByParent: true,
    // PermissionRequest fires "whenever it is about to show a permission
    // dialog". NOT INSTALLED until a live walk: an exit 0 with no blocking
    // decision "automatically approves the action", so its "no decision" is
    // exit 1 (`juniePermission.none`), on every path (`hookExitFor`). Its
    // payload carries no session id: the alias by the parent process finds it.
    answers: "away",
    permissionEvent: "PermissionRequest",
    permissionOut: juniePermission,
    permissionWaitMs: AWAY_WAIT_MS,
    events: {
      SessionStart: (j) => ev("session_start", { sessionKey: sessionKeyOf(j.session_id), cwd: j.cwd ?? j.project_path }),
      UserPromptSubmit: (j) => ev("prompt", { sessionKey: sessionKeyOf(j.session_id), cwd: j.cwd ?? j.project_path }),
      Stop: (j) =>
        ev("turn_end", {
          sessionKey: sessionKeyOf(j.session_id),
          cwd: j.cwd,
          lastMessage: j.last_assistant_message,
          stopActive: j.stop_hook_active,
        }),
      SessionEnd: (j) => ev("session_end", { sessionKey: sessionKeyOf(j.session_id), cwd: j.cwd }),
      // "`tool_input` contains the full serialized action, and `permission_reason` explains why".
      PermissionRequest: (j) =>
        ev("permission", { sessionKey: sessionKeyOf(j.session_id), cwd: j.cwd, tool: j.tool_name, input: j.tool_input, shellTools: JUNIE_SHELL_TOOLS }),
    },
    turnEnd: blockDecision,
  },

  vibe: {
    label: "Mistral Vibe",
    reported: "vibe",
    silent: "",
    deliver: "decision",
    ride: true,
    // "Capped at 3 retries per turn across all post_agent and post_llm hooks".
    cap: 2,
    events: {
      session_start: (j) => (j.parent_session_id ? null : ev("session_start", vibeKey(j))),
      pre_agent: (j) => (j.parent_session_id ? null : ev("prompt", vibeKey(j))),
      post_agent: (j) =>
        j.parent_session_id || (j.agent_name !== undefined && j.agent_name !== "main")
          ? null
          : ev("turn_end", { ...vibeKey(j), lastMessage: j.response_text }),
      notification: (j) => {
        if (j.parent_session_id) return null;
        if (j.notification_type === "approval_requested") return ev("permission", { ...vibeKey(j), tool: j.tool_name });
        if (j.notification_type === "question_asked") return ev("question", vibeKey(j));
        return null;
      },
      session_end: (j) => (j.parent_session_id ? null : ev("session_end", vibeKey(j))),
    },
    turnEnd: (text) => json({ decision: "deny", reason: text }),
    prompt: (text) => json({ hook_specific_output: { additional_context: text } }),
  },

  antigravity: {
    label: "Antigravity",
    reported: "antigravity",
    silent: "",
    deliver: "decision",
    ride: false,
    cap: 3,
    events: {
      SessionStart: (j) => ev("session_start", agyKey(j)),
      Stop: (j) =>
        j.terminationReason !== undefined && j.terminationReason !== "model_stop" ? null : ev("turn_end", agyKey(j)),
    },
    // `decision: "continue"` + reason "re-enter the execution loop".
    turnEnd: (text) => json({ decision: "continue", reason: text }),
  },

  devin: {
    label: "Devin",
    reported: "devin",
    silent: "",
    deliver: "decision",
    ride: false,
    cap: 3,
    // PermissionRequest {tool_name, tool_input}, decision approve or block.
    // NOT INSTALLED until a live walk: what "no decision" does is implied by
    // the documentation's example only, and whether the prompt shows during
    // the hook is not documented.
    answers: "away",
    permissionEvent: "PermissionRequest",
    permissionOut: devinPermission,
    permissionWaitMs: AWAY_WAIT_MS,
    events: {
      SessionStart: (j) => ev("session_start", devinKey(j)),
      UserPromptSubmit: (j) => ev("prompt", devinKey(j)),
      Stop: (j) => ev("turn_end", { ...devinKey(j), stopActive: j.stop_hook_active }),
      SessionEnd: (j) => ev("session_end", devinKey(j)),
      PermissionRequest: (j) => ev("permission", { ...devinKey(j), tool: j.tool_name, input: j.tool_input, shellTools: DEVIN_SHELL_TOOLS }),
    },
    turnEnd: blockDecision,
  },

  continue: {
    label: "Continue CLI",
    reported: "continue-cli",
    silent: "",
    deliver: "decision",
    ride: false,
    cap: 3,
    events: {
      SessionStart: (j) => ev("session_start", { sessionKey: sessionKeyOf(j.session_id), cwd: j.cwd }),
      UserPromptSubmit: (j) => ev("prompt", { sessionKey: sessionKeyOf(j.session_id), cwd: j.cwd }),
      Stop: (j) =>
        ev("turn_end", {
          sessionKey: sessionKeyOf(j.session_id),
          cwd: j.cwd,
          lastMessage: j.last_assistant_message,
          stopActive: j.stop_hook_active,
        }),
      Notification: (j) =>
        j.notification_type === "permission_prompt" ? ev("permission", { sessionKey: sessionKeyOf(j.session_id), cwd: j.cwd }) : null,
      SessionEnd: (j) => ev("session_end", { sessionKey: sessionKeyOf(j.session_id), cwd: j.cwd }),
    },
    turnEnd: blockDecision,
  },

  cline: {
    label: "Cline",
    reported: "cline",
    silent: "",
    // TaskComplete cannot continue a task; UserPromptSubmit's `contextModification` rides along.
    deliver: "none",
    // TaskComplete is "coming soon" in the file hooks, so the session does not
    // say that it reports its turn ends (`waits`): the server then pushes a
    // question at once rather than after an idle post that may never come.
    waits: false,
    ride: true,
    cap: 0,
    events: {
      TaskStart: (j) => ev("session_start", clineKey(j)),
      TaskResume: (j) => ev("session_start", clineKey(j)),
      UserPromptSubmit: (j) => ev("prompt", clineKey(j)),
      TaskComplete: (j) => ev("turn_end", clineKey(j)),
      TaskCancel: (j) => ev("session_end", clineKey(j)),
    },
    prompt: (text) => json({ cancel: false, contextModification: text }),
  },

  windsurf: {
    label: "Windsurf",
    reported: "windsurf",
    silent: "",
    // Cascade's post hooks cannot continue a response.
    deliver: "none",
    ride: false,
    cap: 0,
    events: {
      pre_user_prompt: (j) => ev("prompt", { sessionKey: sessionKeyOf(j.trajectory_id) }),
      post_cascade_response: (j) =>
        ev("turn_end", {
          sessionKey: sessionKeyOf(j.trajectory_id),
          lastMessage: j.tool_info && typeof j.tool_info === "object" ? j.tool_info.response : null,
        }),
    },
  },

  // THE PLUGIN SHIMS: a plugin inside the program (opencode, Kilo Code, Amp)
  // starts the bridge with this small JSON of its own and starts the turn
  // itself with the `deliver` text it reads back.
  // opencode 1.18 keeps its prompt answerable while the plugin's waiter waits,
  // and takes an out-of-band reply. Kilo Code stays on the old path (no
  // answer) until a live walk proves its reply: it ignores a reply that is not
  // interactive for some requests (`permission/index.ts:301-314`). Amp has no
  // permission event in the shim.
  opencode: shim("opencode", "opencode", "always"),
  kilo: shim("Kilo Code", "kilo", "never"),
  amp: shim("Amp", "amp", "never"),
};

/**
 * What the owner sees of a shim's prompt, by `shownInput`: a `bash` prompt
 * (opencode's shell tool asks with `metadata: { command }`) as the bare
 * command, when every other field of its `metadata` is on the closed plain
 * list; else the `patterns` and the `metadata` of the request as compact
 * JSON (an edit's `filepath` and `diff`, an outside folder's `directories`, a
 * `bash` prompt with any other field). The shell decision reads the prompt's
 * own permission word.
 */
function shimShown(j) {
  const metadata = j.metadata && typeof j.metadata === "object" && !Array.isArray(j.metadata) ? j.metadata : null;
  if (j.permission === "bash" && shellCommandOf("bash", metadata, OPENCODE_SHELL_TOOLS) !== null) return toolInputOf(metadata, "bash", OPENCODE_SHELL_TOOLS);
  const rest = {};
  if (j.patterns !== undefined && j.patterns !== null) rest.patterns = j.patterns;
  if (metadata && Object.keys(metadata).length) rest.metadata = metadata;
  return Object.keys(rest).length ? toolInputOf(rest) : { input: null, tooLong: false };
}

function shim(label, reported, answers) {
  const of = (j) => ({ sessionKey: sessionKeyOf(j.sessionID), cwd: j.cwd });
  return {
    label,
    reported,
    silent: "",
    deliver: "shim",
    ride: false,
    cap: 3,
    answers,
    permissionEvent: "permission",
    permissionOut: shimPermission,
    permissionWaitMs: SHIM_PERMISSION_WAIT_MS,
    events: {
      session_start: (j) => ev("session_start", of(j)),
      prompt: (j) => ev("prompt", of(j)),
      turn_end: (j) => ev("turn_end", { ...of(j), lastMessage: j.lastMessage, confirm: j.confirm }),
      // `answer: true`: the plugin started this bridge as the prompt's waiter
      // (it reads the answer from stdout and replies out of band). Without it,
      // the old path: the minute of silence, and nothing printed.
      permission: (j) =>
        ev("permission", {
          ...of(j),
          tool: j.tool,
          requestId: j.requestID,
          answer: j.answer,
          shown: j.answer === true ? shimShown(j) : undefined,
        }),
      // The prompt was answered (opencode's `permission.replied`): the wait is
      // over. `by: "session"` when opencode itself rejected it, after the
      // owner's Deny on another prompt of the session.
      permission_replied: (j) => ev("resolved", { ...of(j), requestId: j.requestID, by: j.by }),
      // The plugin's out-of-band reply of the owner's answer was refused, or
      // threw (the bridge finds the taken request by the prompt's own id).
      reply_refused: (j) => ev("reply_refused", { ...of(j), requestId: j.requestID }),
      session_end: (j) => ev("session_end", of(j)),
      // The doorbell rang while the session was idle: deliver, and nothing else.
      wake: (j) => ev("wake", { ...of(j), confirm: j.confirm }),
      // A shim that confirms: whether its program took the text it was given.
      delivered: (j) => ev("delivered", { ...of(j), ids: j.ids, ok: j.ok }),
    },
    // With `ids` when the shim confirms: it answers `delivered` with them.
    turnEnd: (text, ids) => json(ids ? { deliver: text, ids } : { deliver: text }),
  };
}

function grokKey(j) {
  return { sessionKey: sessionKeyOf(j.sessionId ?? j.session_id), cwd: j.cwd ?? j.workspaceRoot, transcript: j.transcriptPath ?? j.transcript_path };
}

function copilotKey(j) {
  return { sessionKey: sessionKeyOf(j.sessionId ?? j.session_id), cwd: j.cwd, transcript: j.transcriptPath ?? j.transcript_path };
}

/** Copilot's tool arguments: "parsed from JSON string when possible" in the VS Code form, so a JSON string is parsed here too. */
function copilotArgs(value) {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : value;
  } catch {
    return value;
  }
}

function vibeKey(j) {
  return { sessionKey: sessionKeyOf(j.session_id), cwd: j.cwd, transcript: j.transcript_path };
}

function agyKey(j) {
  return { sessionKey: sessionKeyOf(j.conversationId), cwd: firstString(j.workspacePaths) };
}

function devinKey(j) {
  return { sessionKey: sessionKeyOf(j.session_id), cwd: null };
}

function clineKey(j) {
  return { sessionKey: sessionKeyOf(j.taskId), cwd: firstString(j.workspaceRoots) };
}

/**
 * Cursor's events. Grok Build also reads `~/.cursor/hooks.json` and runs its
 * hooks with ITS payload (camelCase, `sessionId`), so a payload with no
 * `conversation_id` is not Cursor's and is ignored: Grok has hooks of its own.
 */
function cursorEvent(event, j, extra = {}) {
  const key = sessionKeyOf(j.conversation_id);
  if (!key) return null;
  return ev(event, { sessionKey: key, cwd: firstString(j.workspace_roots), transcript: j.transcript_path, ...extra });
}

/** The harness entry, or null. Own keys only. */
export function harnessFor(id) {
  return typeof id === "string" && Object.hasOwn(HARNESSES, id) ? HARNESSES[id] : null;
}

/**
 * Does this harness report the person's answer to a permission prompt itself
 * (its adapter maps `permission_replied`: the opencode and Kilo Code plugin)?
 * Then a prompt is still open at the waiter's minute by construction, and the
 * waiter's child-process test is skipped (`bridge.mjs`, /dcr wave 2).
 */
export function reportsPermissionReply(id) {
  return Boolean(harnessFor(id)?.events?.permission_replied);
}

/**
 * One hook's payload, normalized, or null when the bridge has nothing to do
 * with it (an event it does not listen to, a subagent, a payload of another
 * program). `raw` is the hook's stdin, parsed.
 */
export function normalize(harnessId, eventArg, raw) {
  const harness = harnessFor(harnessId);
  if (!harness || typeof eventArg !== "string" || !Object.hasOwn(harness.events, eventArg)) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = harness.events[eventArg](raw);
  if (!out) return null;
  return { harness: harnessId, ...out };
}

/** What the hook prints when it has nothing to say: nothing, or `{}` where only JSON is allowed. */
export function silentOutput(harnessId) {
  return harnessFor(harnessId)?.silent ?? "";
}

/**
 * The decision a turn end prints to hand the owner's text on, or null when
 * the harness cannot continue a turn from a hook.
 */
/**
 * @param {string} harnessId
 * @param {string} text
 * @param {string[] | null} [ids]
 */
export function turnEndDecision(harnessId, text, ids = null) {
  const harness = harnessFor(harnessId);
  return harness?.turnEnd && harness.deliver !== "none" ? harness.turnEnd(text, harness.deliver === "shim" ? ids : null) : null;
}

/** The output of a prompt hook that adds the owner's text to the user's prompt, or null. */
export function promptDecision(harnessId, text) {
  const harness = harnessFor(harnessId);
  return harness?.ride && harness.prompt ? harness.prompt(text) : null;
}

/** When the owner can answer this harness's permission prompt from PasserJack: `always`, `away` or `never`. */
export function permissionTier(harnessId) {
  const answers = harnessFor(harnessId)?.answers;
  return answers === "always" || answers === "away" ? answers : "never";
}

/**
 * The hook's output for the owner's answer: `{ stdout, code }` in the
 * harness's own shape. `behavior` is `allow` or `deny`; `message` is the
 * deny's words (`denyMessage`). Null for a harness with no permission answer.
 *
 * @param {string} harnessId
 * @param {"allow" | "deny"} behavior
 * @param {string | null} [message]
 * @returns {{ stdout: string, code: number } | null}
 */
export function permissionDecision(harnessId, behavior, message = null) {
  const shapes = harnessFor(harnessId)?.permissionOut;
  if (!shapes) return null;
  if (behavior === "allow") return shapes.allow();
  if (behavior === "deny") return shapes.deny(message ?? denyMessage(null));
  return null;
}

/**
 * What a hook prints, and its exit code, when it has NO decision: for the
 * permission event of a harness that answers there, that harness's own "no
 * decision" (Junie: exit 1, because an exit 0 approves); for every other
 * event, the silent output and exit 0. Known from the arguments alone, so the
 * bridge chooses it BEFORE it reads stdin, and every failure path uses it.
 */
export function hookExitFor(harnessId, eventArg) {
  const harness = harnessFor(harnessId);
  if (harness?.permissionOut && harness.permissionEvent === eventArg) return harness.permissionOut.none();
  return { stdout: silentOutput(harnessId), code: 0 };
}

/** The longest a permission hook of this harness waits for the owner, in ms: its installed timeout less a margin. */
export function permissionWaitMs(harnessId) {
  const ms = harnessFor(harnessId)?.permissionWaitMs;
  return Number.isSafeInteger(ms) && ms > 0 ? ms : 0;
}
