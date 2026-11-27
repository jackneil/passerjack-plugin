/**
 * PasserJack for opencode and Kilo Code: ONE plugin file for both plugin APIs.
 * V1 (`@opencode-ai/plugin`, opencode 1.18 and Kilo Code) calls the default
 * export as a function, and a newer V1 calls its `server()`; V2
 * (`@opencode/plugin`) calls its `setup(ctx)`. The three share this file's
 * one rule: every decision is the PasserJack bridge's (`bridge.mjs`), started
 * as a child with the event's small JSON on stdin, and this file only reads
 * the bridge's answer `{"deliver": "<text>", "ids": [...]}` and starts the
 * turn itself. It asks with `confirm: true`, so the bridge acks the owner's
 * messages only when this file says the program TOOK the text (`delivered`
 * with `ok: true`); a prompt that opencode refuses (`ok: false`) puts them
 * back for the next turn end.
 *
 *   - a session starts: the bridge registers it.
 *   - `session.idle` (the turn ended): the bridge posts the minute of silence
 *     with the last message, or hands on an owner message, which this file
 *     sends as a prompt, so the session works on it at once.
 *   - a permission is asked (`permission.asked`, V1 on opencode only): this
 *     file starts ONE WAITER per prompt, a bridge child that it never waits
 *     for, with the prompt's small JSON on its stdin (the tool's input
 *     included, never in argv). The waiter posts the request so the owner
 *     can answer it on the Agents page, and prints `{ "reply": "once" }` or
 *     `{ "reply": "reject" }` when the owner does; this file then answers
 *     opencode out of band. NEVER `always`. The prompt stays answerable at
 *     the terminal the whole time, and the terminal answer wins. A `reject`
 *     in opencode also rejects every other open prompt of that session.
 *     When the bridge gives no remote answers (no saved sign-in, Kilo Code
 *     until a live walk, V2), the bridge posts `waiting_permission` after a
 *     minute, unless `permission.replied` (the user answered) came first.
 *   - `permission.replied`: the bridge closes that prompt's request as
 *     answered at the terminal (nothing for the echo of this file's own
 *     reply), then this file stops the prompt's waiter. A `reject` that
 *     opencode made itself, for another prompt of the session, right after
 *     this file sent the owner's `reject` (`CASCADE_WINDOW_MS`), goes to the
 *     bridge with `by: "session"`: that row closes as closed by the session,
 *     never as answered at the terminal.
 *   - an out-of-band reply that opencode refuses, or that throws: this file
 *     tells the bridge (`reply_refused`, with opencode's id of the prompt),
 *     so the row closes as answered at the terminal and the page stops
 *     saying the owner's answer decided it.
 *   - WHILE A SESSION IS IDLE, this file holds the session's doorbell (the
 *     bridge's `watch` mode, one child per idle session). A line from it is a
 *     message for the session; the bridge hands it on (`wake`) and this file
 *     starts the turn: an owner message wakes an idle session in seconds.
 *
 * The installer writes the absolute paths of node and the bridge in place of
 * the three placeholders below. Nothing here prints, and every failure is
 * silent: the program goes on as if there were no plugin.
 */

import { spawn } from "node:child_process";

const NODE = "__PASSERJACK_NODE__";
const BRIDGE = "__PASSERJACK_BRIDGE__";
const HARNESS = "__PASSERJACK_HARNESS__";

/** The longest a bridge child may take before this file stops waiting for it. */
const BRIDGE_TIMEOUT_MS = 10_000;

/** The most of the bridge's stdout this file reads. */
const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * After this file sends the owner's `reject`, opencode rejects every other
 * open prompt of that session in the same step and sends a
 * `permission.replied` for each (`permission/index.ts` of v1.18.14). A
 * `reject` for another prompt of the session that comes while the reply is
 * on its way, or this long after it, is that cascade.
 */
const CASCADE_WINDOW_MS = 2000;

/**
 * How long a V1 prompt may run before it counts as taken. `session.prompt`
 * answers only when the whole turn has run; a refusal (an unknown session, a
 * bad model, a busy session) answers at once.
 */
const PROMPT_ACCEPT_MS = 2000;

/**
 * The longest a prompt's waiter may run: the bridge's own end of a shim's
 * wait (`SHIM_PERMISSION_WAIT_MS`, twelve hours) and a minute more. The
 * bridge stops first; this is the net for a waiter that hangs.
 */
const WAITER_MAX_MS = 12 * 60 * 60_000 + 60_000;

const ready = () => !NODE.startsWith("__PASSERJACK") && !BRIDGE.startsWith("__PASSERJACK");
const harness = () => (HARNESS === "kilo" ? "kilo" : "opencode");

/**
 * Answers from PasserJack on opencode only. Kilo Code stays on the old path
 * until a live walk proves its reply: it ignores a reply that is not
 * interactive for some requests.
 */
const answersHere = () => harness() === "opencode";

/** Run one bridge event. Resolves `{ text, ids }` when it wants text delivered, or null. */
function callBridge(event, payload) {
  return new Promise((resolve) => {
    if (!ready()) return resolve(null);
    let child;
    try {
      child = spawn(NODE, [BRIDGE, harness(), event], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch {
      return resolve(null);
    }
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), BRIDGE_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_OUTPUT_BYTES) chunks.push(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const out = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const ids = Array.isArray(out?.ids) ? out.ids.filter((id) => typeof id === "string") : [];
        resolve(typeof out?.deliver === "string" && out.deliver ? { text: out.deliver, ids } : null);
      } catch {
        resolve(null);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

/** The doorbells of idle sessions: one bridge `watch` child each. */
function doorbells(onRing) {
  const children = new Map();
  return {
    start(sessionID) {
      if (!ready() || children.has(sessionID)) return;
      let child;
      try {
        child = spawn(NODE, [BRIDGE, "watch", harness(), "--session-key", sessionID], {
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
      } catch {
        return;
      }
      children.set(sessionID, child);
      let buffer = "";
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let at;
        while ((at = buffer.indexOf("\n")) >= 0) {
          buffer = buffer.slice(at + 1);
          onRing(sessionID);
        }
      });
      const forget = () => {
        if (children.get(sessionID) === child) children.delete(sessionID);
      };
      child.on("error", forget);
      child.on("close", forget);
    },
    stop(sessionID) {
      const child = children.get(sessionID);
      if (!child) return;
      children.delete(sessionID);
      child.kill();
    },
    stopAll() {
      for (const id of Array.from(children.keys())) this.stop(id);
    },
  };
}

/**
 * The waiters of open permission prompts: one bridge child each, by
 * opencode's own request id. A waiter's stdout is one JSON line,
 * `{ "reply": "once" | "reject", "message"? }`, or nothing (the prompt closed
 * another way). This file never waits for a waiter in an event handler.
 */
function waiters() {
  const children = new Map();
  return {
    /** Start the waiter of `requestID` once; `onAnswer` gets `{ reply, message }` or nothing. */
    start(requestID, payload, onAnswer) {
      if (!ready() || children.has(requestID)) return;
      let child;
      try {
        child = spawn(NODE, [BRIDGE, harness(), "permission"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      } catch {
        return;
      }
      children.set(requestID, child);
      const chunks = [];
      let size = 0;
      const timer = setTimeout(() => child.kill(), WAITER_MAX_MS);
      timer.unref?.();
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size <= MAX_OUTPUT_BYTES) chunks.push(chunk);
      });
      const done = () => {
        clearTimeout(timer);
        if (children.get(requestID) === child) children.delete(requestID);
      };
      child.on("error", done);
      child.on("close", () => {
        const mine = children.get(requestID) === child;
        done();
        // A waiter that this file stopped (the prompt was answered) answers nothing.
        if (!mine) return;
        try {
          const out = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (out?.reply === "once" || out?.reply === "reject") {
            onAnswer({ reply: out.reply, message: typeof out.message === "string" && out.message ? out.message : null });
          }
        } catch {
          // No answer: the prompt stays at the terminal.
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(payload));
    },
    stop(requestID) {
      const child = children.get(requestID);
      if (!child) return;
      children.delete(requestID);
      child.kill();
    },
    stopAll() {
      for (const id of Array.from(children.keys())) this.stop(id);
    },
  };
}

/**
 * Answer one prompt of opencode out of band, with the owner's `once` or
 * `reject`. NEVER `always`. The V1 client's
 * `postSessionIdPermissionsPermissionId` (`POST
 * /session/:id/permissions/:permissionID`, which opencode 1.18.14 serves)
 * takes `response` only, so a deny note does not reach opencode there; a
 * client with the newer `permission.reply` carries it as `message`. Answers
 * whether opencode took it.
 */
async function replyPermission(client, sessionID, requestID, reply, message) {
  try {
    if (typeof client?.permission?.reply === "function") {
      return !refused(await client.permission.reply(message ? { requestID, reply, message } : { requestID, reply }));
    }
    if (typeof client?.postSessionIdPermissionsPermissionId === "function") {
      return !refused(await client.postSessionIdPermissionsPermissionId({ path: { id: sessionID, permissionID: requestID }, body: { response: reply } }));
    }
  } catch {
    // Refused: the prompt stays at the terminal.
  }
  return false;
}

const idOf = (value) => (typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null);

/**
 * Hand the owner's text to the program with `send` (true when the program
 * took it), then tell the bridge, which acks the messages or puts them back.
 * Answers whether the text was taken.
 */
async function deliver(sessionID, cwd, out, send) {
  const taken = await send(sessionID, out.text).catch(() => false);
  if (out.ids.length) await callBridge("delivered", { sessionID, cwd, ids: out.ids, ok: taken });
  return taken;
}

/**
 * Did a V1 SDK call answer with a refusal? The generated client does not
 * throw on an HTTP error: it answers `{ error, response }`.
 */
const refused = (res) => Boolean(res && typeof res === "object" && (res.error || res.response?.ok === false));

/**
 * The session's last assistant message, through the V1 client: its text and
 * the model that wrote it, so a delivered message goes on with the model the
 * user chose (a prompt with no model would take the agent's default). Nulls
 * on any failure.
 */
async function lastAssistant(client, sessionID) {
  try {
    const res = await client.session.messages({ path: { id: sessionID } });
    const list = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const entry = list[i];
      if (entry?.info?.role !== "assistant") continue;
      const text = (Array.isArray(entry.parts) ? entry.parts : [])
        .filter((part) => part?.type === "text" && typeof part.text === "string" && !part.synthetic)
        .map((part) => part.text)
        .join("\n")
        .trim();
      const { providerID, modelID } = entry.info;
      const model = typeof providerID === "string" && typeof modelID === "string" ? { providerID, modelID } : null;
      return { text: text || null, model };
    }
  } catch {
    // No text: the turn end is posted without it.
  }
  return { text: null, model: null };
}

/** V1: the hooks object. `client` talks to this opencode server. */
async function server({ client, directory }) {
  const cwd = typeof directory === "string" ? directory : null;
  const busy = new Set();
  const models = new Map();
  // True only when opencode took the prompt: `promptAsync` answers once it
  // is queued; `prompt` answers when the whole turn has run, so a prompt that
  // has not failed after PROMPT_ACCEPT_MS counts as taken.
  const prompt = async (sessionID, text) => {
    try {
      const model = models.get(sessionID);
      const body = model ? { parts: [{ type: "text", text }], model } : { parts: [{ type: "text", text }] };
      const args = { path: { id: sessionID }, body };
      if (typeof client.session.promptAsync === "function") return !refused(await client.session.promptAsync(args));
      const call = client.session.prompt(args).then(
        (res) => !refused(res),
        () => false,
      );
      return await Promise.race([call, new Promise((resolve) => setTimeout(() => resolve(true), PROMPT_ACCEPT_MS))]);
    } catch {
      return false;
    }
  };
  const bells = doorbells(async (sessionID) => {
    if (busy.has(sessionID)) return;
    const out = await callBridge("wake", { sessionID, cwd, confirm: true });
    if (out) {
      bells.stop(sessionID);
      if (!(await deliver(sessionID, cwd, out, prompt))) bells.start(sessionID);
    }
  });
  const asks = waiters();
  // The owner's own `reject` in flight, by session: `{ own, until }` (`CASCADE_WINDOW_MS`).
  const rejecting = new Map();
  const cascadeOf = (sessionID, requestID) => {
    const sent = rejecting.get(sessionID);
    if (!sent) return false;
    if (Date.now() > sent.until) {
      rejecting.delete(sessionID);
      return false;
    }
    return sent.own !== requestID;
  };
  /** Hand the owner's answer to opencode, and tell the bridge when opencode did not take it. */
  const answerOut = async (sessionID, requestID, answer) => {
    if (answer.reply === "reject") rejecting.set(sessionID, { own: requestID, until: Number.POSITIVE_INFINITY });
    const ok = await replyPermission(client, sessionID, requestID, answer.reply, answer.message).catch(() => false);
    if (answer.reply === "reject") rejecting.set(sessionID, { own: requestID, until: Date.now() + CASCADE_WINDOW_MS });
    if (!ok) await callBridge("reply_refused", { sessionID, cwd, requestID });
  };
  return {
    event: async ({ event }) => {
      try {
        const props = event?.properties ?? {};
        if (event?.type === "session.created") {
          const id = idOf(props.info?.id);
          if (id) await callBridge("session_start", { sessionID: id, cwd });
        } else if (event?.type === "session.status") {
          const id = idOf(props.sessionID);
          if (id && props.status?.type === "busy") {
            busy.add(id);
            bells.stop(id);
          }
        } else if (event?.type === "session.idle") {
          const id = idOf(props.sessionID);
          if (!id) return;
          busy.delete(id);
          const last = await lastAssistant(client, id);
          if (last.model) models.set(id, last.model);
          const out = await callBridge("turn_end", { sessionID: id, cwd, lastMessage: last.text, confirm: true });
          if (out && (await deliver(id, cwd, out, prompt))) return;
          bells.start(id);
        } else if (event?.type === "permission.updated" || event?.type === "permission.asked") {
          const id = idOf(props.sessionID);
          if (!id) return;
          const tool = props.type ?? props.permission ?? null;
          const requestID = idOf(props.id);
          if (answersHere() && requestID) {
            // One waiter per prompt, by opencode's id (both events can come
            // for one prompt): it holds the input on its stdin and answers
            // `{ reply }` when the owner does. Not awaited: opencode's bus
            // never waits for the owner.
            asks.start(
              requestID,
              {
                sessionID: id,
                cwd,
                tool,
                requestID,
                answer: true,
                permission: props.permission ?? props.type ?? null,
                patterns: props.patterns ?? props.pattern ?? null,
                metadata: props.metadata ?? null,
              },
              (answer) => {
                answerOut(id, requestID, answer).catch(() => {});
              },
            );
          } else {
            await callBridge("permission", { sessionID: id, cwd, tool });
          }
        } else if (event?.type === "permission.replied") {
          // The prompt was answered: the wait is over, exactly. The bridge
          // closes its request first (as answered at the terminal, or nothing
          // for the echo of this file's own reply), then the waiter stops, so
          // the waiter's guard never reads the stop as a lost waiter.
          const id = idOf(props.sessionID);
          const requestID = idOf(props.requestID ?? props.permissionID);
          // opencode 1.18.14 names the answer `reply`; an older one, `response`.
          const reply = props.reply ?? props.response ?? null;
          const bySession = Boolean(id && requestID && reply === "reject" && cascadeOf(id, requestID));
          if (id) {
            const payload = requestID ? { sessionID: id, cwd, requestID } : { sessionID: id, cwd };
            await callBridge("permission_replied", bySession ? { ...payload, by: "session" } : payload);
          }
          if (requestID) asks.stop(requestID);
        } else if (event?.type === "session.deleted") {
          const id = idOf(props.info?.id);
          if (!id) return;
          bells.stop(id);
          models.delete(id);
          await callBridge("session_end", { sessionID: id, cwd });
        }
      } catch {
        // Never let PasserJack break the session.
      }
    },
    "chat.message": async (input) => {
      const id = idOf(input?.sessionID);
      if (id) await callBridge("prompt", { sessionID: id, cwd });
    },
    dispose: async () => {
      bells.stopAll();
      // A stopped waiter's guard closes its request as one that PasserJack can no longer answer.
      asks.stopAll();
    },
  };
}

/**
 * V2: the documented `setup(ctx)`. NOT RUN ON A LIVE V2 OPENCODE YET (this
 * computer has 1.18): the event names and `ctx.session.synthetic` are the
 * V2 documentation's, and the last message is not read on V2.
 */
async function setup(ctx) {
  const cwd = typeof ctx?.location?.directory === "string" ? ctx.location.directory : null;
  const synthetic = async (sessionID, text) => {
    try {
      await ctx.session.synthetic({ sessionID, text });
      return true;
    } catch {
      return false;
    }
  };
  const busy = new Set();
  const bells = doorbells(async (sessionID) => {
    if (busy.has(sessionID)) return;
    const out = await callBridge("wake", { sessionID, cwd, confirm: true });
    if (out) {
      bells.stop(sessionID);
      if (!(await deliver(sessionID, cwd, out, synthetic))) bells.start(sessionID);
    }
  });
  const sessionOf = (event) => idOf(event?.sessionID ?? event?.properties?.sessionID ?? event?.data?.sessionID);
  let events;
  try {
    events = await ctx.event.subscribe({ types: ["session.idle", "session.status", "permission.asked", "permission.replied"] });
  } catch {
    return;
  }
  (async () => {
    try {
      for await (const event of events) {
        const id = sessionOf(event);
        if (!id) continue;
        if (event.type === "session.status") {
          const status = event.status ?? event.properties?.status;
          if (status?.type === "busy" || status === "busy") {
            busy.add(id);
            bells.stop(id);
          }
        } else if (event.type === "session.idle") {
          busy.delete(id);
          const out = await callBridge("turn_end", { sessionID: id, cwd, lastMessage: null, confirm: true });
          if (out && (await deliver(id, cwd, out, synthetic))) continue;
          bells.start(id);
        } else if (event.type === "permission.replied") {
          await callBridge("permission_replied", { sessionID: id, cwd });
        } else if (event.type === "permission.asked") {
          await callBridge("permission", { sessionID: id, cwd, tool: event.permission ?? event.properties?.permission ?? null });
        }
      }
    } catch {
      // The subscription ended.
    }
  })();
  try {
    await ctx.session.hook("prompt", async (event) => {
      const id = sessionOf(event);
      if (id) await callBridge("prompt", { sessionID: id, cwd });
    });
  } catch {
    // No prompt hook: the next turn end still clears the wait.
  }
}

/** V1 calls a function export, a newer V1 calls `server()`, V2 calls `setup()`. */
const plugin = async (input) => server(input);
plugin.id = "passerjack";
plugin.server = server;
plugin.setup = setup;

export default plugin;
