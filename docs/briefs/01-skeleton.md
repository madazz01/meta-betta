# Brief 01 — Extension skeleton with a chat panel (no AI yet)

Read `AGENTS.md` first.

## Goal
A VS Code extension that opens a chat panel. Typing a message and pressing Enter shows it as a chat bubble, and a fake reply comes back ("Echo: <message>"). No Muse yet. This proves the panel ↔ extension plumbing.

## Build
1. Create the extension in `extension/`:
   - `package.json`: name `meta-betta`, displayName `Meta Betta`, publisher `madazz01`, engines `vscode ^1.90.0`, `main: ./out/extension.js`, `"type"` NOT set to module (CommonJS output from tsc is fine).
   - Contributes:
     - a command `metaBetta.open` titled **"Meta Betta: Open chat"**;
     - an Activity Bar view container `metaBetta` (title "Meta Betta", simple SVG icon in `extension/media/icon.svg`: a coffee cup) holding a **webview view** `metaBetta.chat` named "Chat". (Use a WebviewViewProvider so the chat lives in the side bar, like other chat extensions.)
   - Dev dependencies only: `typescript`, `@types/vscode` (match engines), `@types/node`. Scripts: `build` (`tsc -p .`), `watch`, `test`.
   - `tsconfig.json`: target ES2022, module commonjs, outDir `out`, strict.
2. `extension/src/extension.ts`: register the provider + command (command focuses the view).
3. `extension/src/chatView.ts`: the WebviewViewProvider.
   - Webview HTML from `extension/media/chat.html`, `chat.css`, `chat.js` (vanilla). Use a strict Content-Security-Policy with a nonce; load the files via `webview.asWebviewUri`.
   - Messages: webview → host `{ type: "send", text }`; host → webview `{ type: "reply", text }`, `{ type: "status", text }`.
   - For now the host replies `Echo: <text>` after 300 ms.
4. The panel look (match VS Code theme via CSS variables like `--vscode-editor-background`, `--vscode-foreground`, `--vscode-input-background`):
   - message list (user bubbles right, assistant left), auto-scroll;
   - a text box at the bottom (Enter sends, Shift+Enter new line) and a Send button;
   - an empty-state line: "Morning! What are we working on?"
5. Pure logic worth testing (put it in `extension/src/lib/` and test with `node --test`): e.g. a `formatMessage` / message-list reducer. Keep VS Code imports out of `lib/`.
6. `.vscode/launch.json` at repo root with an "Run Meta Betta" extension-host launch config (`--extensionDevelopmentPath=${workspaceFolder}/extension`) and a preLaunch build task in `.vscode/tasks.json`.

## Done when
- `cd extension && npm install && npm run build && npm test` all pass.
- Pressing F5 in VS Code (with the repo open) launches a second VS Code window with a coffee-cup icon in the Activity Bar; clicking it shows the chat; typing "hi" shows "hi" then "Echo: hi".

## Handover
Plain English, click-by-click: how to launch it (F5), what they should see, what you couldn't test. Commit `01: extension skeleton with chat panel`.
