# What we found while building

Building Meta Betta meant driving Muse Code through its SDK every day, so we hit a few things along the way. None of this is a complaint. Muse is great, and we just made it play nice. We've written down what we found, how we proved it, and what we did about it, in case it helps Meta or anyone else building on Muse.

Muse CLI 1.4.14, `@muse-code/sdk`, Windows 11.

---

## 1. Shell commands fail in serve mode on Windows

**What happens:** when you drive Muse through the SDK (`muse serve`), every shell command fails with:

```
sandbox enforcement unavailable: windows_elevated setup_required:
windows elevated sandbox setup has not run
```

But `muse sandbox windows check` says `status=ready`, and shell commands work fine in the terminal and with `muse exec`. Reading and editing files through serve works. Only running commands is broken, so Muse can't build or run tests from an SDK app.

**How we proved it:** [`spike/shellcheck.mjs`](spike/shellcheck.mjs) asks Muse to run `echo sandbox-ok` through serve. We tried `--trust-workspace`, `--sandbox-network enabled` and `restricted`, and `--join`. All gave the same error. We posted it on the Meta thread in the hackathon Discord.

**Is it a bug or a wall?** We think it's a bug. The check and serve disagree on the same machine, the same sandbox works in `exec`, and serve has its own `--disable-sandbox` option. It doesn't look like something meant to block SDK apps.

**What we did:** on Windows, Meta Betta starts serve with `--disable-sandbox`. We **don't** leave it there, though, see the next one.

## 2. With the sandbox off, the default mode didn't ask first

**What happens:** with the sandbox off and the session's default approval mode, Muse ran our test command without asking. That makes sense when the sandbox is on, because the sandbox is the safety. Turn the sandbox off and nothing is checking anymore.

**How we proved it:** [`spike/approvalmode.mjs`](spike/approvalmode.mjs) runs the same command before and after switching modes.

**What we did:** right after starting a session, Meta Betta calls `session/setApprovalMode` with `promptUnmatched`. Muse then asks before every command, one ask per part (`a; b; c` is 3 asks), with the same choices you'd expect from any coding agent:

> **Allow once** · **Always allow in this workspace: New-Item ...** · **Reject**

If that mode doesn't switch on, Meta Betta won't send the message at all. Every change still gets an ↩ Undo button on top. When Meta fixes the sandbox, one setting turns all of this off.

## 3. There's no Stop button in the SDK, but you can build one

**What happens:** `MuseClient` keeps its connection private, so there's no obvious way to stop a reply halfway through. Even Muse told us Stop wasn't possible.

**How we proved it:** [`spike/stop.mjs`](spike/stop.mjs). The SDK exports everything you need to build the client yourself:

```js
const handshake = spawnMspConnection({ command: museBin, args: ["serve"] });
const spawned = await handshake.initialize({ clientInfo });
const client = new MuseClient(spawned.connection, {
  durability: readSessionDurability(spawned.initializeResult),
  host: spawned,
});
// later:
await spawned.connection.command("turn/interrupt", { sessionId, turnId });
```

**Watch out:** `turn.completed` still resolves with kind `"completed"` after a stop. To see that it was stopped, check `params.terminal === "cancelled"`.

## 4. The connection only holds one notification handler

**What happens:** `connection.onNotification(...)` keeps only one handler. `MuseClient` sets its own when it's created. If your app adds one afterwards (we did, to watch usage and goals), it **replaces** the SDK's, and turns stop getting their events. For us, side questions just sat on "working" forever.

**What we did:** before creating `MuseClient`, we wrap `onNotification` so it keeps a list and calls every handler, each one in its own try/catch so one error can't starve the others. See `chainNotifications()` in [`extension/src/muse/museHost.ts`](extension/src/muse/museHost.ts).

## 5. Muse has a built-in approval judge (good to know)

**What happens:** even in `promptUnmatched` mode, some commands run without asking you. That is Muse's approval judge, a second model that reviews each command before you see it. For "run node --version" its log said: approve, "User explicitly requested node --version check, low-risk version query", risk low, user authorization high. Riskier things still come to you.

**What we did:** kept it. It's the fix for clicking yes every two seconds. Our own picker only shows up for what the judge passes on.

## 6. Shell stages don't include redirection

**What happens:** each approval request lists the command's stages as `argv`. For `Write-Output hello > out.txt` the stages are just `[["Write-Output","hello"]]`. The `> out.txt` part is gone, and you only see it in the full `command` text. Variables come through as-is too: `Get-Content $HOME\.gitconfig` arrives as `["Get-Content","$HOME","\\.gitconfig"]`.

**Why it matters:** we auto-allow plain read-only steps (list files, read a file in the project) so you're not asked ten times to delete one file. Going by `argv` alone, that write to `out.txt` would have looked read-only.

**What we did:** before auto-allowing anything, Meta Betta checks the full command for `>` and write commands, refuses any path with `$ % ~`, a backtick or wildcards, and only auto-allows reads inside the project. Everything else goes to the picker.

---

Found something else? Open an issue. Happy to compare notes.
