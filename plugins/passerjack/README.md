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

The file is the plugin's own sign-in. A browser sign-in asks for `read` and
nothing more, so a write with it is refused. A pasted key keeps the scopes you
gave it. The file's first line, `purpose`, says that it is not for other
programs or agents: an agent connects with its own PasserJack connection (the
MCP tools). To
put a secret that is a file in the Vault, an agent uses `create_upload_link`
with `target: "vault"`, which keeps the secret out of its context.

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
| `PASSERJACK_API_KEY` | unset | An API key from Settings > Agents on passerjack.com. When it is set, the watcher uses it and not the saved sign-in. A change to it needs a restart of Claude Code. Most people do not need it: use `/passerjack:connect`. When the key and the saved sign-in are of different accounts, the watcher does nothing and prints one line (see "A key and a sign-in of two accounts"). A key alone cannot answer a permission prompt from the Agents page (see "Answer a permission prompt from PasserJack"). |
| `PASSERJACK_WATCH_TAG` | `claude` | Items you tag with this wake the session. Set it to an empty value to turn items off. |
| `PASSERJACK_WATCH_NAME` | unset | Adds a mailbox: messages sent to this name (`desk`, `laptop`) wake the session too, and the session is listed under this name. Without it the session still hears messages sent by hints, and Claude can give the session a name while it runs (see "Give the session a name"). When it is set, the watcher puts this name back each time it reconnects. |
| `PASSERJACK_SHARE_LAST_MESSAGE` | on | The hooks send a finished turn's last message to your Agents page after a minute of silence. Exactly `0` turns that off on this computer: the page still shows that the session waits for you, with no text (see "The Agents page"). |
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
  when a message for the name this session holds arrives
  (`PASSERJACK_WATCH_NAME`, or a name Claude gave the session).
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
- `[passerjack] watch stopped: PASSERJACK_API_KEY and the saved sign-in are different accounts. Remove one.`
  when the key and the saved sign-in belong to two accounts (see "A key and a
  sign-in of two accounts").

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

## Give the session a name

The name lives on the session that the watcher registered. Ask Claude to give
this session a name and it calls `set_status` with the session's id and a
`name` (1 to 32 characters of a-z, 0-9, dot, dash and underscore). From then
on, messages sent to that name ring this watch at once, with no restart and no
environment variable. Claude does not call `register_session` in Claude Code:
that makes a second session that has no watch, so nothing rings for it. The
skill in version 0.3.0 and later tells Claude to do this. The server half works
with every version of the watcher, because the watcher itself did not change.

A sender by name is told `listening: false` when nothing woke (no live
session holds the name, or the sessions that hold it have no watch open), so
it tells you rather than wait in silence. A new watcher process (a
new `registered as` line with a new id) is a new session: give it the name
again.

## The Agents page

On passerjack.com (or in the app) the Agents page lists every agent session
of your account and what each one waits for. You can write to one session
there, and read its answer. A message you type on that page is your own words
to that one session: the watcher wakes the session, and the skill tells Claude
to act on it as on a line you typed in the terminal, inside your standing
instructions and its normal permission rules. Every other message stays
untrusted data.

When Claude needs a decision and you are away, it asks with `message_user`
and `question: true`. The page shows the question in amber, and your phone
gets a push.

An owner message rings as `[passerjack] message 1a2b3c4d for this session
<full session id> from "you, on the Agents page"`. Claude reads it with that
full id and does not call `list_sessions` first.

### Answer a permission prompt from PasserJack

When Claude Code shows a permission prompt, the plugin (version 0.4.0 and
later) also shows it on the Agents page, and you can answer it there from a
computer, a phone browser or the app:

- **Allow** lets the session use the tool one time. Allow needs a check on
  this device first: your passkey, Face ID or Touch ID. One check is good for
  10 minutes. An account with no passkey can sign in again instead.
- **Allow for this session** shows when Claude Code suggested rules or
  folders for the prompt. The page lists each rule and folder before you
  press it. They stay in force until the session ends, and never go into a
  settings file.
- **Deny** needs no check. You can add a note of up to 500 characters. Claude
  reads the note as your words: "The owner denied this tool call from
  PasserJack. The owner wrote: ...". A Codex session that the agent bridge
  connects reads the same words.

The prompt stays live at the terminal the whole time, and the first answer
wins. When you answer at the terminal, the plugin closes the prompt on the
page as soon as it sees the answer (the tool's result, a finished or a failed
tool, a new prompt, the end of the turn). Then PasserJack can no longer answer it. After a minute with no
answer, your phone gets a push. The push and the bell never show what the
tool would do: only the Agents page shows it.

What goes to PasserJack for this: the tool's name and its exact input (the
Bash command as it is, or another tool's input as JSON), to your own account
only. The page shows the input. The server erases it when the prompt closes,
and it is never in a push, an export or a log line. An input over 4000
characters is never cut: the page says that it is too long to show, and you
can only Deny it there.

The plugin answers these prompts itself, with no question to you:
`check_messages`, `ack_message`, `message_user`, `set_status` and
`list_sessions`, from the PasserJack MCP server named `passerjack` that you
added yourself (`claude mcp add`), for this session only. So an owner message
never waits on a prompt. Every other PasserJack tool asks as usual. A server
under another name, or one that a repository's `.mcp.json` adds, is not
matched.

Remote answers need the saved sign-in from `/passerjack:connect` (or
`--paste`). With only `PASSERJACK_API_KEY`, every prompt stays at the
terminal, and the push still comes. A key and a saved sign-in of the SAME
account can answer too. This is so a repository that sets the key in its
settings cannot press Allow on this computer from another account.

The prompt hook waits for your answer for up to 12 hours. A waiting hook is
one small process and one request every 25 seconds.

### A key and a sign-in of two accounts

When `PASSERJACK_API_KEY` and the saved sign-in belong to different accounts,
the watcher registers nothing, the hooks send nothing, and the session gets
one line:

```
[passerjack] watch stopped: PASSERJACK_API_KEY and the saved sign-in are different accounts. Remove one.
```

Remove the variable, or run `/passerjack:connect --sign-out`. When the saved
sign-in changes to the key's account, or goes, the watch starts by itself. The
watcher compares the two accounts (one `GET /api/me` with each) when it starts
and each time the saved sign-in changes.

### What the hooks send, and where

The plugin has seven hooks (`hooks/hooks.json`). Six run in the background,
print nothing, and exit with no error whatever happens. The seventh, for a
permission prompt, runs in the foreground: it prints only your answer from the
Agents page, and prints nothing on every other path. A hook that sends
something sends small requests to `POST /api/sessions/<id>/state` on
PasserJack (and, for a permission prompt, `/api/sessions/<id>/permissions/...`),
for the session that this watcher registered, with the credential that
registered it:

- **After a turn ends.** When nothing happens for a minute (no prompt, no tool
  result, no new turn, no `/clear`) and no background task other than this
  watcher runs, it says that the session waits for you, with the turn's last
  message. The text goes to your own PasserJack account and shows on the
  Agents page. It never sends a push.
- **A permission prompt.** After 2 seconds, the prompt hook sends the tool's
  name and input, and waits for your answer (see "Answer a permission prompt
  from PasserJack"). After a minute with no answer it asks for a push. A
  prompt that you approved, whose tool still runs, sends no push: the hook
  sees the tool's process. A prompt that the prompt hook does not take (no
  saved sign-in, or a prompt for a network request of a sandboxed command)
  gets the push after a minute, with the tool's name only: answer it at the
  terminal.
- **A tool finishes after a permission prompt.** It says that the session
  works again.
- **You type.** Each prompt you type says that the session works, so a
  question you answer at the terminal never reaches your phone.

The hooks keep a small file of their own beside the watcher's file: a counter,
the permission prompt that is up, and one entry for each prompt hook that
waits. It never holds a text, a key or a token.

The watcher tells the hooks which session it holds through a small file in
`~/.config/passerjack/sessions/` (`%LOCALAPPDATA%\PasserJack\sessions\` on
Windows): the session id, the PasserJack address, the watcher's process id,
and a hash that says which credential may get your answers to a prompt. The
file never holds a key or a token. A hook never renews a sign-in: it uses
the token the watcher keeps current, and skips one post when that token has
run out.

### Do not send the turn's text

To keep the turn's last message on this computer, set this before you start
Claude Code:

```
export PASSERJACK_SHARE_LAST_MESSAGE=0
```

Exactly `0` turns it off; any other value, or none, leaves it on. With it off,
the page still shows that the session waits for you, with no text.

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
- `PASSERJACK_WATCH_NAME`, when set, or the name the agent gives the session
  with `set_status`,
- a one-line status, when the agent sets one with `set_status`.

Every agent with a key on your account can read these with `list_sessions`, so
do not name a folder or branch after something private. The key itself is
never sent anywhere but the request header.

The listing stays current while the watcher is connected. When Claude Code
closes, the session goes quiet and drops off the list of live sessions within
ten minutes. The watcher never deletes the session: its Agents page
conversation stays, with any message from you that it did not read yet, and
the session expires a day after its last sign of life. When you start Claude
Code again in the same conversation (a resume), the watcher comes back to the
same session, so a message that you sent meanwhile still reaches it. If
registering fails for any reason, the watcher prints nothing about it and
keeps watching.

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
