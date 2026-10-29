# Brief 09 — First run: download, paste key, go

Read `AGENTS.md` first. Briefs 01–08 must be done.

## Goal
From "just installed the extension" to "Muse is ready ✓" with no terminal knowledge: Meta Betta installs Muse Code for you, you paste your API key (or sign in), and it fixes the Windows sandbox if needed. Every step is a friendly card with one button. Nothing runs without a click.

## Facts (checked 29 Oct on muse 1.4.14)
- `muse login`: "Log in with your Meta account: approve a code in your browser. **META_API_KEY always takes priority over the account login.**"
- `muse auth set [--provider <PROVIDER>] --api-key-stdin`: stores a key, read from stdin (never on the command line).
- `muse sandbox windows check` / `muse sandbox windows setup` (setup needs admin once).
- Meta's installer on Windows: `irm https://dev.meta.ai/install.ps1 | iex`. **Get the Mac/Linux line from Meta's own page or docs; don't guess it.** If you can't find it, show a link to the page instead of running anything.

## Build
1. `extension/src/setup/firstRun.ts`: a checklist run when the chat opens: **Muse installed? → connected (key or login)? → sandbox ready (Windows)? → test turn OK?** Pure logic testable with fakes; each check returns ok / fixable / blocked with a plain message.
2. **Not installed:** card "Muse Code isn't installed yet. [Install it for me] [How to do it myself]". Install runs Meta's official one-liner in a **visible VS Code terminal** named "Muse install" (the user sees exactly what runs). When the terminal finishes, re-check. Reuse the existing bin-finding code (`resolveBin.ts`).
3. **Not connected:** card "Connect Muse: [Paste API key] [Sign in with Meta]".
   - Paste API key: an input box (password style). Store it in **VS Code SecretStorage** (`context.secrets`), never in settings or files. Pass it to `muse serve` as the `META_API_KEY` environment variable. Offer [Forget my key] in the Meta Betta settings/commands.
   - Sign in: run `muse login` in a visible terminal; re-check when it finishes.
   - Say plainly which one is in use and that billing can differ: "Using your API key (billed to your Meta API account: credits or pay as you go)" / "Using your Meta login (your Muse Code plan)".
4. **Windows sandbox not ready:** card "Muse needs a one-time safety setup on Windows. It asks for admin once. [Set it up]" → runs `muse sandbox windows setup` in a visible terminal. Also: if VS Code itself is running as Administrator, show one line suggesting a normal launch (the sandbox is set up per user; we saw "sandbox enforcement unavailable" when running as admin).
5. **Ready:** a quick test turn ("Reply with just: ready"), then "Muse is ready ✓" and straight into the welcome (brief 06). Cache "ready" so later starts skip the checklist unless something fails.
6. Tests: checklist order and each state with fakes; the key never appears in logs, settings or the chat transcript.

## Done when
- Build + tests pass.
- On a machine without Muse: click Install → Meta's installer runs in a terminal → paste key → (Windows) sandbox setup → "Muse is ready ✓" → welcome.
- With a pasted key, `muse serve` gets `META_API_KEY`, and the key is not stored anywhere but SecretStorage.

## Handover
Plain English + commit `09: first run`.
