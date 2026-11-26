/**
 * PasserJack for Amp: a plugin (`~/.config/amp/plugins/passerjack.ts`) that
 * starts the PasserJack bridge (`bridge.mjs`) on Amp's own events and reads
 * the bridge's answer `{"deliver": "<text>"}`.
 *
 *   - `session.start`: the bridge registers the thread as a session.
 *   - `agent.start`: a sign of life (the user sent a message).
 *   - `agent.end` with status `done`: the bridge posts the minute of silence
 *     with the last message, or hands on an owner message, which this
 *     plugin returns as Amp's documented `{ action: "continue", userMessage }`
 *     (Amp caps plugin continuations at `maxContinuations`, 5 by default).
 *
 * NOT RUN ON A LIVE AMP YET: Amp is not installed on the computer where this
 * was written. The event names and shapes are Amp's plugin API reference
 * (ampcode.com/docs/plugin-api, read 2026-11-25). The installer writes the
 * absolute paths of node and the bridge in place of the placeholders. Nothing
 * here prints, and every failure is silent.
 */

import { spawn } from "node:child_process";

const NODE = "__PASSERJACK_NODE__";
const BRIDGE = "__PASSERJACK_BRIDGE__";

const BRIDGE_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

const ready = () => !NODE.startsWith("__PASSERJACK") && !BRIDGE.startsWith("__PASSERJACK");

function callBridge(event: string, payload: Record<string, unknown>): Promise<string | null> {
  return new Promise((resolve) => {
    if (!ready()) return resolve(null);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(NODE, [BRIDGE, "amp", event], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch {
      return resolve(null);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), BRIDGE_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
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
        resolve(typeof out?.deliver === "string" && out.deliver ? out.deliver : null);
      } catch {
        resolve(null);
      }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(payload));
  });
}

type Block = { type?: string; text?: string };
type Message = { role?: string; content?: Block[] };

/** The text of the turn's last assistant message, or null. */
function lastAssistantText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as Message;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}

const threadOf = (event: unknown): string | null => {
  const id = (event as { thread?: { id?: unknown } })?.thread?.id;
  return typeof id === "string" && id.length > 0 && id.length <= 200 ? id : null;
};

// The plugin API object; typed loosely so the file needs no Amp package to load.
export default function passerjackAmpPlugin(amp: { on: (name: string, handler: (event: unknown) => unknown) => void }) {
  const cwd = process.cwd();
  amp.on("session.start", async (event) => {
    const id = threadOf(event);
    if (id) await callBridge("session_start", { sessionID: id, cwd });
  });
  amp.on("agent.start", async (event) => {
    const id = threadOf(event);
    if (id) await callBridge("prompt", { sessionID: id, cwd });
  });
  amp.on("agent.end", async (event) => {
    const id = threadOf(event);
    if (!id || (event as { status?: unknown })?.status !== "done") return;
    const lastMessage = lastAssistantText((event as { messages?: unknown }).messages);
    const text = await callBridge("turn_end", { sessionID: id, cwd, lastMessage });
    if (text) return { action: "continue", userMessage: text };
  });
}
