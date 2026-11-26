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
 *   - PostToolUse: a tool finished, so a permission prompt that was up was
 *     answered. ONLY while a mark is set: the mark is cleared and `working`
 *     is posted, which resolves the permission row. A tool call whose
 *     `tool_use_id` is not the marked one (a parallel tool, a subagent's)
 *     clears nothing.
 *   - UserPromptSubmit: bump the counter, clear the mark, and post `working`
 *     for every prompt the person TYPED. A turn that a monitor line starts
 *     arrives as a `<task-notification>` prompt, and it says nothing about the
 *     person. EVERY typed prompt, not only one after a posted wait: a question
 *     the agent asked and the person answered at the terminal inside the
 *     minute has no posted wait, and without this post the next turn's `idle`
 *     would push that answered question to the phone (C9). The server answers
 *     a `working` that changes nothing with no frame.
 *   - SessionStart: bump the counter and clear the mark.
 *
 * SILENT ON EVERY FAILURE: nothing is ever printed (not the message, not a
 * question, not a credential), and the hook exits 0 whatever happened.
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
  const size = deps.size(transcript);
  return size !== null && size === baseline;
}

/**
 * Run one hook. `event` is `stop`, `permission`, `idle`, `tool`, `prompt` or
 * `start`; `input` is the parsed stdin. Resolves to what was posted (`idle`,
 * `waiting_permission`, `working`) or null. Never throws.
 *
 * @param {"stop" | "permission" | "idle" | "tool" | "prompt" | "start"} event
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
      });
      return null;
    }

    if (event === "prompt") {
      // Every prompt is a sign of life, a monitor's turn too: a Stop waiter of
      // the turn before must not post `idle` over the turn that started.
      await deps.update((s) => {
        s.turn += 1;
        s.pending = null;
      });
      if (!typedPrompt(input.prompt)) return null;
      const link = deps.link();
      if (!link) return null;
      return (await deps.post(link, { state: "working" })) ? "working" : null;
    }

    if (event === "tool") {
      // Most PostToolUse fires find no mark: read first, lock only when there is one.
      if (!deps.state()?.pending) return null;
      const id = typeof input.tool_use_id === "string" ? input.tool_use_id : null;
      const cleared = await deps.update((s) => {
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
      const pending = deps.state()?.pending;
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
      const turn = await deps.update((s) => {
        s.pending = null;
        return s.turn;
      });
      if (waitsOnWork(input.background_tasks, deps.env.CLAUDE_PLUGIN_ROOT)) return null;
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
      if (!(await stillAfterMinute(deps, transcript, baseline, startedAt))) {
        // The session moved: no later `idle_prompt` may post this mark either.
        await deps.update((s) => {
          if (s.pending?.n === mark) s.pending = null;
        });
        return null;
      }
      const current = deps.state()?.pending;
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
  } catch {
    return null;
  }
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
