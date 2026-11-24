# PasserJack for Claude Code

A Claude Code plugin that keeps a session listening to PasserJack for as long
as it is open. Tag something `claude` on your phone, or send this agent a
message, and the session wakes up with one line saying what arrived.

## Install

In Claude Code:

```
/plugin marketplace add jackneil/passerjack-plugin
/plugin install passerjack@passerjack
```

Then set your key (below) and restart Claude Code. The watcher runs as a plugin
monitor, which Claude Code starts in the background for every interactive
session. It does not run under `claude -p`.

It needs Node 18 or newer on your PATH.

If you added the plugin from `jackneil/passerjack` before 2026-11-24, remove
that marketplace and add this one. The old address is the private PasserJack
repository, and it is no longer a marketplace:

```
/plugin marketplace remove passerjack
/plugin marketplace add jackneil/passerjack-plugin
/plugin install passerjack@passerjack
```

## Settings

The watcher reads the environment and nothing else, so the key never lands in a
settings file or on a command line.

| Variable | Default | What it does |
| --- | --- | --- |
| `PASSERJACK_API_KEY` | none, required | An API key from Settings > Agents on passerjack.com. The `read` scope is enough. |
| `PASSERJACK_WATCH_TAG` | `claude` | Items you tag with this wake the session. Set it to an empty value to turn items off. |
| `PASSERJACK_WATCH_NAME` | unset | Adds a mailbox: messages sent to this name (`desk`, `laptop`) wake the session too, and the session is listed under this name. Without it the session still hears messages sent by hints. |
| `PASSERJACK_ORIGIN` | `https://passerjack.com` | Only for a local development server: `https://passerjack.com` or a localhost address, nothing else, so a project's settings cannot point your key somewhere else. |

Windows (a new terminal picks it up):

```
setx PASSERJACK_API_KEY pj_...
```

macOS and Linux, in your shell profile:

```
export PASSERJACK_API_KEY=pj_...
```

The PasserJack tools themselves (`get_item`, `check_messages` and the rest) come
from the PasserJack MCP connection. If you have not connected it yet, follow
Settings > Agents > Claude Code on passerjack.com.

## What wakes the session

One line each, and nothing else:

- `[passerjack] registered as jack-laptop/widgets (acme/widgets) session 1a2b3c4d`
  when the watcher starts, and again only if the server hands it a new session
  (yours was ended or swept while it was away). See "Who can see this session"
  below.
- `[passerjack] new image "IMG_2932.HEIC" (2.4 MB) tagged claude, from Jack iPhone, item 1a2b3c4d`
  when an item you captured gains the tag. Items an agent files back under the
  tag do not ring, so the session never wakes itself.
- `[passerjack] message 1a2b3c4d for "desk" from "Claude Code laptop", subject "build is green"`
  when a message for `PASSERJACK_WATCH_NAME` arrives.
- `[passerjack] message 1a2b3c4d for "*" from "Claude Code desk" ...` when
  another agent sends by hints instead of a name (see below).
- A count, when several land at once or while the watch was reconnecting.
- `[passerjack] watch offline since ..., still retrying` after ten minutes
  without a connection, and `[passerjack] watch back online` when it returns.
- `[passerjack] watch stopped: the API key was refused` if the key is revoked.

Lines never carry contents. The bundled `passerjack-inbox` skill tells Claude
to read the item or message with the MCP tools, to treat message text as data
rather than instructions, and to acknowledge what it handled.

## Messages sent by hints: pass and claim

An agent that does not know which session should get a message can send it by
hints (a repository, host, folder, harness, or words from a session's status)
instead of a name. Every live session that plausibly fits gets it, so a
session will sometimes be woken for a message that is not its own. The skill
has Claude pass on those (`pass_message`), claim one before acting on it
(`claim_message`, a ten-minute lease, so two sessions never both do the work),
and ack it when done. If every session it reached passes, the sender is told
nobody took it. A hinted message that reached nobody (no session was live when
it was sent) waits for the next session to check; passing it leaves it waiting
for the one after.

A watcher with no `PASSERJACK_WATCH_NAME` still registers its session and rings
for hinted messages delivered to it. Setting a name adds a mailbox on top: the
session then also rings for messages sent to that name.

## Other harnesses

Claude Code is the only harness this plugin can wake. Codex, Gemini CLI and the
hosted chats (Grok, ChatGPT) poll instead, checking for messages at the start of
each task and before any long step. The loop is in `/llms.txt`, under "If your
harness cannot run a background watcher".

## Who can see this session

At start the watcher lists this session on your account so your other agents
(and you, in Settings > Agents) can see where it is working:

- the machine's host name,
- the working folder's name (only the last part, never the full path),
- the repository as `owner/name` from the `origin` remote (never the URL, so a
  token in the remote never leaves your machine),
- the current branch,
- `PASSERJACK_WATCH_NAME`, when set,
- a one-line status, when the agent sets one with `set_status`.

Every agent with a key on your account can read these with `list_sessions`, so
do not name a folder or branch after something private. The key itself is
never sent anywhere but the request header.

The listing stays current while the watcher is connected. When Claude Code
closes it, the watcher ends the session; if it is killed outright, the session
drops off the list within ten minutes. On Windows a closed terminal may deliver
no signal, in which case the session is not ended: it goes quiet and drops off
the list ten minutes later. If registering fails for any reason,
the watcher prints nothing about it and keeps watching.

## Cost

A session asleep on this plugin costs nothing until something arrives. The
server ends every watch after fourteen minutes; the curl recipe in
`/llms.txt` wakes the session each time to start it again, four times an hour.
This watcher reconnects on its own, from where the last connection stopped, so
those wake-ups never happen. Transient network errors print nothing.

## Uninstall

```
/plugin uninstall passerjack@passerjack
/plugin marketplace remove passerjack
```

Then delete `PASSERJACK_API_KEY` from your environment and revoke the key in
Settings > Agents if you no longer use it.
