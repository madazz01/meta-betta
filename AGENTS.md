# AGENTS.md — Meta Betta

Read this whole file before every task. Then read the brief you were given in `docs/briefs/`.

## What we're building

**Meta Betta — the dev's assistant.** *Coffee and Muse. New mornings without the restarts.*

A VS Code extension that puts a friendly chat panel on top of **Muse Code** (driven through Meta's own SDK, `@muse-code/sdk`), plus a **brain folder** that remembers the person and their project, so every session starts with "here's where we're up to" instead of from zero.

It has the same shape as other agent chat extensions:

```
 webview panel (chat + brain cards)   ← plain HTML/CSS/JS, no framework
        ▲  postMessage  ▼
 extension host (TypeScript)          ← talks to VS Code + the SDK, writes brain files
        ▲  @muse-code/sdk  ▼
 muse serve (Muse Code agent)         ← the brain and the tools
```

We copy the *shape and feel* of good chat extensions. **Never copy code from any other product** (including Claude Code or Cline). Write everything fresh.

## Look and feel (match this design; write the code fresh)

A calm chat page, not a terminal:
- **Header:** session title (short, auto-named), buttons: history (`/resume`), new chat, 💾 Save my day.
- **Messages:** user and assistant bubbles with small timestamps; pasted images as a thumbnail chip with name + size.
- **Thinking:** one quiet grey line, "Thought for 12s", click to expand. Never a wall of text.
- **Plan:** when Muse makes a plan/checklist, show it as a small card at the top of the reply with ticks as steps finish.
- **Tool rows:** one line each, e.g. "📄 Wrote extension.ts (+16 lines)", "▶ Ran npm test ✓". Code/diffs/output folded away; click to expand into a small monospace box. Never dump code into the chat by default.
- **Input box (bottom, rounded):** attach (+), text area, mic (voice), model chip (e.g. "Muse Spark 1.3"), approval-mode chip, send/stop button. Status line under it ("Muse is working… · Saved ✓ 2:15pm").
- Follow the VS Code theme (light/dark) with `--vscode-*` CSS variables. Plenty of spacing, readable font size.

## Who it's for

Developers (e.g. people in the Meta hackathon). They already know VS Code, files and chat, so don't over-explain the basics; what's new to them is working with an agent that remembers. Every word the user sees is still **plain English**: no stack traces, no "coerced numeric strings". Say what it does for them, briefly.

## Hard rules

1. **Stay inside this repo.** Never read, write or run anything outside `C:\meta-betta` (or the workspace the extension is opened in, at runtime).
2. **Small steps.** Do only the brief you were given. If you think something else is needed, write it under "Suggestions" in your final message; don't build it.
3. **Simplest thing that works.** No frameworks in the webview (vanilla HTML/CSS/JS). No new dependencies unless the brief allows them. TypeScript + `tsc` for the extension.
4. **No secrets in the repo.** No API keys, tokens or personal data. The repo is public.
5. **Test what you build.** Unit tests with Node's built-in runner (`node --test`) for pure logic. Say plainly what you could not test (e.g. "I couldn't click through the panel; please try X").
6. **Finish with a plain handover:** what you built (2–4 lines), exactly how to try it (click-by-click), what you couldn't check, and suggestions. No code dumps in the handover.
7. **Commit when a brief is done**, one commit per brief, message starting with the brief number, e.g. `01: extension skeleton with chat panel`. Don't push.
8. **Sign your commits.** End every commit message with a blank line and then this exact line, with the model you're running as:
   `Built-by: Muse Code (<model id, e.g. muse-spark-1.3-contributor>)`
   Fix-up commits after review use the same line. (Claude's commits carry `Co-Authored-By: Claude …` instead, so `git log` shows who did what.)
9. **Add to config files, never replace them.** When a file like `.gitignore`, `package.json` or `AGENTS.md` already exists, edit it in place and keep everything already there.

## Muse Code SDK — facts already proven (28 Oct, see `spike/`)

- Package: `@muse-code/sdk` **1.4.14** (pin exactly; it versions in lockstep with Muse Code). ESM, zero deps, Node ≥ 20.
- Spawn: `const client = await MuseClient.spawn({ museBin, args: ["serve"], clientInfo: { name: "meta_betta", version } })`
  - **`clientInfo.name` must match `^[a-z0-9_]+$`** (the SDK README's `"my-app"` is rejected by the server).
- Session: `await client.startSession({ workspaceRoot })` → `session.sessionId`.
- Resume (works from a brand-new process): `await client.resumeSession({ sessionId, onApproval, onApprovalError })`.
- Turn: `const turn = await session.sendUserTurn({ input: [{ type: "text", text }] })`
  - `turn.items()` = async iterator, replays then live; `turn.deltas()` = live text only; `await turn.completed` → `{ kind: "completed" | "cancelled" | "failed", ... }`.
  - Item types seen: `userMessage`, `reasoning` (model thinking: hide or collapse), `agentMessage` (the reply: show), `reminderChild` (internal: hide).
  - **Deltas mix reasoning text with the answer**, so route text by item type, not by raw deltas.
- Approvals: `session.onApproval(async (req) => ({ choiceId: req.availableChoices[i].choiceId }))`. With no handler the server default-denies tool use.
- Close: `await client.close()`.
- Full types are in `node_modules/@muse-code/sdk/dist/src/**/*.d.ts`; read them instead of guessing. Docs: https://meta-models.github.io/muse-code-sdk/1.4/
- Muse binary on Windows: `%LOCALAPPDATA%\Programs\muse\muse-bin-<version>.exe` (version in the filename). Resolve it at runtime: setting `metaBetta.museBin` → else newest `muse-bin-*.exe` in that folder → else `muse` on PATH.

## Muse Code features we switch on (don't reinvent them)

- `AGENTS.md` at the workspace root is read automatically each session → our "front door". **Only if the workspace is trusted:** spawn the host with `args: ["serve", "--trust-workspace"]`, otherwise Muse ignores AGENTS.md entirely (proven 28 Oct: without it, "Morning" got a generic reply; with it, Muse opened with "Here's where we're up to:" from the brain). Follow VS Code's own Workspace Trust (`vscode.workspace.isTrusted`): trusted folder → pass the flag and turn memory on; Restricted Mode → no flag, memory off (brief 04).
- In a trusted workspace (default approval mode `on-request`), Muse edited files inside the workspace without an approval prompt during the brain test; approval cards still matter for shell commands and anything outside.
- Memory: `MEMORY.md` index + one Markdown file per topic → Muse recalls it automatically.

## The brain folder (what makes it Meta Betta)

Created in the user's workspace at `brain/`:

| File | Purpose |
|---|---|
| `brain/me.md` | Who the user is, how they like to be talked to (short vs full, plain words…) |
| `brain/project.md` | What they're building (a short **START HERE** at the top) + **Updates**: dated entries, one per save, each tagged with its chat's session label. The brain only grows: entries are added, never overwritten |
| `brain/tricks.md` | Workarounds that worked, one per line, newest first |
| `brain/good-for.md` | Plain-English list of what Muse has actually done for this user |
| `brain/log/YYYY-MM-DD.md` | What happened today |

The workspace `AGENTS.md` (front door) tells Muse: read the brain at the start, open with "Here's where we're up to…", follow the loop, keep the brain up to date when asked to save.

**The loop Muse follows:** KNOW (read the brain) → AIM (user's goal in plain words) → SHAPE (propose the simplest version, get a yes) → DO (when blocked, try 2–3 other ways, say which worked) → CHECK (show the result, ask if it's right) → SAVE (update the brain).

## Build order (briefs in `docs/briefs/`)

01 extension skeleton + chat panel (echo) → 02 wire chat to Muse Code → 03 resume + new session → 04 brain folder + brain panel → 05 Save my day + periodic quick saves → 05b safety net (back up before changing + ↩ Undo that) → 06 welcome (name, what we're doing, 3-part memory tour) → 07 plain handovers + "did you know I can also…" → 08 slash commands (/usage, /resume, /model, /compact, /recap, /save …) + status-bar usage → 09 first run (install Muse for you, paste API key, sandbox setup).
