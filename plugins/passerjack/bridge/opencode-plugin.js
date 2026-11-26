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
 *   - a permission is asked: the bridge posts `waiting_permission` after a
 *     minute, unless `permission.replied` (the user answered) came first.
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
 * How long a V1 prompt may run before it counts as taken. `session.prompt`
 * answers only when the whole turn has run; a refusal (an unknown session, a
 * bad model, a busy session) answers at once.
 */
const PROMPT_ACCEPT_MS = 2000;

const ready = () => !NODE.startsWith("__PASSERJACK") && !BRIDGE.startsWith("__PASSERJACK");
const harness = () => (HARNESS === "kilo" ? "kilo" : "opencode");

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
          if (id) await callBridge("permission", { sessionID: id, cwd, tool: props.type ?? props.permission ?? null });
        } else if (event?.type === "permission.replied") {
          // The user answered the prompt: the wait is over, exactly.
          const id = idOf(props.sessionID);
          if (id) await callBridge("permission_replied", { sessionID: id, cwd });
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
    dispose: async () => bells.stopAll(),
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
