# 10 — Release: a clean .vsix anyone can install

Read `AGENTS.md` first. 08h must be done. Start on a clean tree.

## Why
Bryan is releasing Meta Betta to the other hackathon entrants (Tue 3 Nov). People will
install it from a GitHub Release. It has to install cleanly, look finished, and never lose
anyone's work.

## Build
1. **package.json:** `version` 0.1.0; `displayName` "Meta Betta"; `description` "A friendly VS Code
   workmate for Muse Code that remembers you and your project."; `repository`
   `{ "type": "git", "url": "https://github.com/madazz01/meta-betta" }`; `homepage` and `bugs`
   (the repo and its /issues); `icon` `media/icon.png`; `categories` ["AI", "Chat"]; `keywords`
   (muse, meta, ai, chat, memory); `galleryBanner` dark. Keep `license` MIT.
2. **Icon:** `extension/media/icon.png`, 128×128, the same "Mb" mark as the activity-bar icon,
   white on a dark rounded square with a small green (`--mb-accent` colour) accent. Draw it as an
   SVG first (`media/icon.svg`), then render the PNG with a tiny node script using what's already
   in node_modules, or plain SVG→PNG via a canvas-free approach. If rendering isn't possible
   without new deps, say so and keep the SVG; Claude will render the PNG.
3. **Lean package:** add `extension/.vscodeignore` that excludes `src/**`, `out/test/**`,
   `**/*.map`, `tsconfig.json`, `**/*.test.*`, `.vscode/**`, and dev-only node_modules. Copy
   `LICENSE` and a short `extension/README.md` (what it is, install, first run, link to the repo)
   and `extension/CHANGELOG.md` (0.1.0: first public release, bullet list of features) into the
   extension folder so the package carries them.
4. **Build script:** `npm run package` → `npx @vscode/vsce@3.2.1 package -o ../dist/meta-betta-0.1.0.vsix`
   (add `dist/` to the repo .gitignore). It must run with **no warnings or prompts**.
5. **Root README install section** (top, right after the headline/tagline):
   - Download `meta-betta-0.1.0.vsix` from the latest GitHub Release.
   - VS Code → Extensions → ⋯ → **Install from VSIX…** → pick the file.
   - Open a project folder → click the **M** icon → Open chat. First run sets up Muse inside the panel.
   - **Honest notes:** tested on Windows 11; Mac/Linux should work but are untested; uses your own Muse
     credits; Windows uses a sandbox workaround (see WHAT-WE-FOUND.md), so Muse asks before
     commands (Approvals: Auto skips the safe ones); every change can be undone (↩ Undo) and files
     are backed up to `.backups/` before changes. On the contributor model, keep secrets out of
     the folder.
   - Feedback: GitHub Issues.
   - A **"Built with Meta Betta"** badge snippet people can paste into their own README:
     `[![Built with Meta Betta](https://img.shields.io/badge/built%20with-Meta%20Betta-1f9d55)](https://github.com/madazz01/meta-betta)`
6. **Smoke test the package** (not just unit tests): install the built .vsix into VS Code with
   `code --install-extension dist/meta-betta-0.1.0.vsix --force`, confirm it activates and the M
   icon shows. Report the .vsix size and file count (should be well under 1 MB without src/tests).

## Done when
- `npm run package` produces `dist/meta-betta-0.1.0.vsix` with no warnings, no src/tests inside.
- Installs and activates. The Extensions view shows the icon, name, description, version 0.1.0.
- README has the install section, honest notes and the badge.
- All tests still pass.

## Handover
Plain English + commit `10: release packaging`. Don't create the GitHub Release (Claude/Bryan do
that). Don't push.
