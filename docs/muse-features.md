# Everything Muse Code can do (checked 29 Oct 2026, muse 1.4.14)

Sources: the SDK's protocol list (`MspMethod` in `node_modules/@muse-code/sdk/dist/src/msp.d.ts`, 68 commands) and Muse's own built-in tips list (each tip has a "when it's useful" line). Our rule: **every good feature gets a button, a slash command or a nudge. Nothing stays hidden.** The tips below are described in our own words.

## Muse's own tips (feature → when it helps → how Meta Betta shows it)

| Feature | When it helps | Meta Betta |
|---|---|---|
| **Goal with progress bar** (`/goal`) | A long, multi-step job | `/goal` + pinned goal card (brief 08) |
| **Side question** (`/side`) | You want to ask something off-topic without derailing the job | `/side <question>` → answer in a small side card; main chat untouched (`session/sideChat`) |
| **Fork** (`/fork`) | Trying a different approach without losing the current one | `/fork` + a "Try another way from here" item on any message (`session/fork`) |
| **Resume** (`/resume`) | Picking up earlier or lost work | `/resume` (brief 08) |
| **Workflows** ("use a workflow") | A big job that can be split up: an audit, a migration, a broad review | Nudge: "Big job? Say 'use a workflow' and I'll split it across helpers." `workflow/pause/resume/cancel` buttons while one runs |
| **Monitor** | A long build or log is running | Nudge: "Want me to watch that build and tell you when it changes?" |
| **Helpers / subagents** (`/agent`) | Several helpers are working | A "Helpers" card listing them, with Stop (`subagent/*`) |
| **Task list** (`/tasks`) | Several things running at once | `/tasks` card: workflows, helpers and terminals in one place, Stop each or Stop all (`task/list`, `task/stop`, `task/stopAll`) |
| **Background a task** (Ctrl+B) | A long build or test is blocking the chat | "Send to background" button on a running tool row (`task/background`) |
| **Repeat on a timer** (`/loop 10m …`) | You keep re-checking something by hand | Nudge only for now (terminal feature) |
| **Skills** (`/skills`) | You keep doing the same procedure by hand | `/skills`: browse, turn on/off (`skill/list`, `skill/setActivation`, `skill/import`) |
| **Plugins** (`/plugins`) | You want something Muse can't do yet | `/plugins`: browse and install (`plugin/list`, `plugin/install`, marketplace add/update/remove) |
| **Effort** (`/effort`) | Replies feel slow, or too shallow | `/effort` + a chip in the input bar: quick / normal / deep (`session/setReasoningEffort`) |
| **Usage** (`/usage`) | Wondering about cost | `/usage` + status bar (brief 08; `usage/read`, `session/tokenUsage`) |
| **Export** (`/export`) | Sharing or keeping a conversation | `/export` → save a text/Markdown file (CLI `muse export`, or build it from history) |
| **Steer / queue** (Tab) | You think of a follow-up while it's still working | Typing while it runs: [Send now] steers the current job (`turn/steer`), [Queue] sends after (and `turn/unqueue` to take it back) |
| **@ file mentions** | Pointing at a specific file | Type `@` in the input → pick a workspace file |
| **! shell command** | A quick command you want to run yourself | Start a message with `!` → runs it and shows the output (`session/userShell`) |
| **Paste an image** (Ctrl+V) | Screenshots, UI, diagrams | Paste or drop images into the input (`media/upload`) |
| **Voice** (Alt+V) | Long explanations are easier said than typed | 🎤 mic button in the input bar (`muse voice`, Meta's voice-transcribe model) |
| **Expand tool output** (Ctrl+O) | You want to see what a command printed | Click a tool row to expand it (`item/readOutput`) |
| **Keyboard shortcuts** (?) | New to the controls | Our `/help` lists the panel's shortcuts |

## Other useful engine commands (not in Muse's tips)

| Command | What it's for | Meta Betta |
|---|---|---|
| `session/rename` | Name a chat | Rename the session label (brief 04) also renames the Muse session |
| `session/setApprovalMode` | How much Muse asks before acting | Approval chip in the input bar: "Ask me first" / "Just do it in this folder" |
| `model/list`, `session/setModel` | Pick a model | `/model` (brief 08), list from `model/list` |
| `session/compact`, `recap/request` | Tidy a long chat, quick summary | `/compact`, `/recap` (brief 08) |
| `approval/listPending` | Approvals waiting | Show pending approval cards after a resume |
| `userInput/answer/clarify/cancel` | Muse asking you a question with choices | Show as a card with buttons |
| `feedback/submit` | Tell Meta what worked or didn't | 👍/👎 on a reply → sends feedback to Meta (optional, say so) |
| `computerUse*` | Muse controlling the screen | Later, if at all |
| `hook/list` | Automation hooks | Later |

## Where each piece lands
- **Brief 07 (nudges):** seed the nudge list from the "when it helps" column above.
- **Brief 08 (slash commands):** add `/side`, `/fork`, `/tasks`, `/skills`, `/plugins`, `/effort`, `/export` to the table, plus the effort and approval chips.
- **Later (if time):** steer/queue while running, `@` mentions, `!` shell, image paste, mic, helpers card, 👍/👎 feedback.
