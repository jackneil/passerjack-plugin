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
 * text), the user's e-mail address (Cursor). None of that leaves this module.
 * The one exception is the TRANSCRIPT PATH, kept so that a waiter can tell
 * that the session moved during its minute: the bridge reads that file's SIZE
 * only, never its content, and the path stays in the 0600 state file on this
 * computer.
 *
 * DEPENDENCY-FREE, like the rest of the plugin: Node 18+. Its one import is
 * the Claude Code plugin's `../bin/hook-core.mjs`, for the two rules the bridge
 * must apply exactly as the plugin does: the tool-name shape and the cut of a
 * last message.
 */

import { clipText, LIVE_TASK_STATES, MAX_SENT_CHARS, TOOL_RE } from "../bin/hook-core.mjs";

/** What the bridge does with a normalized event. */
export const BRIDGE_EVENTS = ["session_start", "prompt", "turn_end", "permission", "question", "resolved", "session_end", "last_text", "wake", "delivered"];

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
 */
function ev(event, fields) {
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
      // No decision printed: "decline to decide and let the normal approval prompt continue".
      PermissionRequest: (j) =>
        ev("permission", { sessionKey: sessionKeyOf(j.session_id), cwd: j.cwd, tool: j.tool_name, transcript: j.transcript_path }),
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
      // NEVER PermissionRequest: an exit 0 with no decision "automatically approves the action".
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
    events: {
      SessionStart: (j) => ev("session_start", devinKey(j)),
      UserPromptSubmit: (j) => ev("prompt", devinKey(j)),
      Stop: (j) => ev("turn_end", { ...devinKey(j), stopActive: j.stop_hook_active }),
      SessionEnd: (j) => ev("session_end", devinKey(j)),
      // Not PermissionRequest: what no decision does there is not documented.
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
  opencode: shim("opencode", "opencode"),
  kilo: shim("Kilo Code", "kilo"),
  amp: shim("Amp", "amp"),
};

function shim(label, reported) {
  const of = (j) => ({ sessionKey: sessionKeyOf(j.sessionID), cwd: j.cwd });
  return {
    label,
    reported,
    silent: "",
    deliver: "shim",
    ride: false,
    cap: 3,
    events: {
      session_start: (j) => ev("session_start", of(j)),
      prompt: (j) => ev("prompt", of(j)),
      turn_end: (j) => ev("turn_end", { ...of(j), lastMessage: j.lastMessage, confirm: j.confirm }),
      permission: (j) => ev("permission", { ...of(j), tool: j.tool }),
      // The user answered the prompt (opencode's `permission.replied`): the wait is over.
      permission_replied: (j) => ev("resolved", of(j)),
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
