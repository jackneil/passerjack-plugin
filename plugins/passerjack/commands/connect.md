---
description: Connect this computer to PasserJack. A browser sign-in, or --paste a key, --status, --sign-out.
argument-hint: "[--paste [file] | --status | --sign-out]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/connect.mjs":*)
---

Connect this Claude Code to PasserJack, so that the `passerjack-watch` monitor
can wake this session. The user's argument: `$ARGUMENTS`

1. Use only an empty argument, `--paste`, `--paste <file>`, `--status` or
   `--sign-out`. For any other argument, tell the user these choices and stop.
   - If the argument starts with `pj_` or holds a PasserJack API key, do not
     run anything. Tell the user: the key is now in this conversation, so they
     must revoke it in Settings > Agents and make a new one. Then they copy the
     new key and run `/passerjack:connect --paste`, or put it in a file and run
     `/passerjack:connect --paste <file>`. Do not repeat the key.
2. This is the command. Do not change it:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/connect.mjs" $ARGUMENTS
   ```

3. With `--paste`, `--paste <file>`, `--status` or `--sign-out`, run it with
   the Bash tool and wait for it. It ends in a few seconds. With `--paste`, the
   user must first press Copy the key in Settings > Agents on passerjack.com.
4. With an empty argument (the browser sign-in):
   - Tell the user in one sentence: "A PasserJack tab opens in your browser.
     Press Connect there." The card says Unverified app, because the plugin
     gives itself its name. That is correct.
   - Run the command as a BACKGROUND Bash task, because it waits up to 9
     minutes for Connect. After a few seconds, read its output and give the
     user the address on the line that starts with `[passerjack] a browser tab
     opens`. The user opens that address if no tab opened.
   - If a line says `this computer is remote or has no desktop`, tell the user
     to open the address on any computer and press Connect. The page after
     that does not load. The user copies the full address of that page (it
     starts with `http://127.0.0.1:`) and gives it to you. Then run this, with
     the address in single quotes, and wait for it. Do not use double quotes:
     a shell changes `$` and backticks inside them.

     ```
     node "${CLAUDE_PLUGIN_ROOT}/bin/connect.mjs" --relay '<address>'
     ```

   - When the background task ends, report its `[passerjack]` lines.
   - If you cannot run a background task, run it in the foreground with a Bash
     timeout of 600000 ms.
5. Tell the user each line that starts with `[passerjack]`, as written.
   - `connected as ...` or `saved the sign-in ...`: the watch starts by itself
     within a few seconds. No restart is necessary. The monitor then prints
     `[passerjack] registered as ...`. If that line does not come within about
     10 seconds, tell the user to run `/reload-plugins`.
   - `connect failed: ...`, `connect stopped: ...`, `sign-in not saved ...`
     or `sign-out not finished: ...`: the line says what to do.
   - `note: ...`: tell the user the note.
6. The output never contains a key or a token. Do not look for one, and do not
   read the credentials file or a key file.
