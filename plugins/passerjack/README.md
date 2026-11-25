# PasserJack for Claude Code

A Claude Code plugin that keeps a session listening to PasserJack for as long
as it is open. Tag something `claude` on your phone, or send this agent a
message, and the session wakes up with one line saying what arrived.

## Install

In Claude Code:

```
/plugin marketplace add jackneil/passerjack-plugin
/plugin install passerjack@passerjack
/passerjack:connect
```

The second command opens the plugin details. Choose Install for you (user
scope). If Claude Code tells you to run `/reload-plugins`, run it before
`/passerjack:connect`.

The last command opens PasserJack in your browser. Press Connect. The card
says Unverified app, because the plugin gives itself its name. That is
correct. The watch then starts in this session within a few seconds. You do
not edit a shell profile, copy a key or restart Claude Code.

The watcher runs as a plugin monitor, which Claude Code starts in the
background for every interactive session. It does not run under `claude -p`.

It needs Node 18 or newer on your PATH.

If you added the plugin from `jackneil/passerjack` before 2026-11-24, remove
that marketplace and add this one. The old address is the private PasserJack
repository, and it is no longer a marketplace:

```
/plugin marketplace remove passerjack
/plugin marketplace add jackneil/passerjack-plugin
/plugin install passerjack@passerjack
```

If you update from version 0.1.0 inside a session that is open, restart
Claude Code one time after `/passerjack:connect`. The 0.1.0 watcher stopped
when it found no key, and `/reload-plugins` does not start a monitor again in
the same session. Version 0.2.0 and later does not stop: it waits for the
sign-in.

## Connect

`/passerjack:connect` does one of these things:

| Command | What it does |
| --- | --- |
| `/passerjack:connect` | Signs in through your browser. It asks for the `read` permission only. |
| `/passerjack:connect --paste` | Saves an API key from your clipboard. |
| `/passerjack:connect --paste <file>` | Saves an API key from a file. Use it when the computer has no clipboard. Delete the file after. |
| `/passerjack:connect --status` | Says if this computer is connected, and to which account. If the server renewed the sign-in but the saved file could not be written, it says `sign-in not saved` and the sign-in stops working soon: make the file's folder writable and connect again. |
| `/passerjack:connect --sign-out` | Ends the sign-in on the server and deletes the saved file. If the server does not confirm it, the file stays and the line says so. |

To make a key for `--paste`: in Settings > Agents on passerjack.com, open Use
an API key instead, choose View only, press Create a key and fill this in,
then press Copy the key. The watch needs View only. The file keeps the key at
rest, so do not give it more.

### A computer with no browser

Claude Code over SSH, or a server with no desktop, cannot open the sign-in
page itself. Run `/passerjack:connect` there. Open the address that it shows
on any computer and press Connect. The page after that does not load, because
it goes to `127.0.0.1` on the computer with the browser. Copy the full
address of that page and give it to Claude. Claude sends it to the waiting
sign-in on the remote computer. The address holds a one-time code that works
only for that sign-in.

You can also make a key, put it in a file on that computer (for example with
`scp`), and run `/passerjack:connect --paste <file>`.

### Where the sign-in is saved

The sign-in is saved in one file that only you can read:

- Windows: `AppData\Local\PasserJack\credentials.json` in your user folder.
  It is not in the roaming profile, because the sign-in belongs to this
  computer.
- macOS and Linux: `~/.config/passerjack/credentials.json`

No setting moves this file. A project's Claude Code settings can set
environment variables, so a setting that moved the file would let a project
put your sign-in inside itself.

Every Claude Code session on the computer uses the same file. The watcher
renews the sign-in before it expires. When several sessions renew at the same
time, a lock lets only one of them renew, and the others read its result. The
connection shows in Settings > Agents > Connected apps as "PasserJack for
Claude Code on <your computer>". Disconnect it there to stop it.

A new sign-in ends the one it replaces on the server. Every running session
sees a sign-out or a new sign-in within a few seconds. After a sign-out the
watch stops with no line. After a new sign-in the watch starts again on it.

If the sign-in stops working (you disconnected it, or 90 days passed), the
session gets one line, `[passerjack] watch stopped: sign-in expired, run
/passerjack:connect`. Run that command and the watch starts again by itself.

## Settings

All settings are optional. The watcher reads them from the environment.

| Variable | Default | What it does |
| --- | --- | --- |
| `PASSERJACK_API_KEY` | unset | An API key from Settings > Agents on passerjack.com. When it is set, the watcher uses it and not the saved sign-in. A change to it needs a restart of Claude Code. Most people do not need it: use `/passerjack:connect`. |
| `PASSERJACK_WATCH_TAG` | `claude` | Items you tag with this wake the session. Set it to an empty value to turn items off. |
| `PASSERJACK_WATCH_NAME` | unset | Adds a mailbox: messages sent to this name (`desk`, `laptop`) wake the session too, and the session is listed under this name. Without it the session still hears messages sent by hints. |
| `PASSERJACK_ORIGIN` | `https://passerjack.com` | Only for a local development server: `https://passerjack.com` or a localhost address, nothing else, so a project's settings cannot point your key somewhere else. The saved sign-in is used only for the origin it was made on. |

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
- `[passerjack] watch waiting for sign-in: run /passerjack:connect` when this
  computer is not connected yet. The watch starts by itself after the sign-in.
- `[passerjack] watch stopped: sign-in expired, run /passerjack:connect` (or
  `the saved API key was refused`) when the saved sign-in stops working.
- `[passerjack] watch stopped: the API key was refused` if the key in
  `PASSERJACK_API_KEY` is revoked.

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
/passerjack:connect --sign-out
/plugin uninstall passerjack@passerjack
/plugin marketplace remove passerjack
```

The first command ends the sign-in on the server and deletes the saved file.
Run it before the uninstall, because the uninstall removes the command. If you
set `PASSERJACK_API_KEY`, delete it from your environment and revoke the key in
Settings > Agents.
