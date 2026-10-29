# Meta Betta — the dev's assistant

**Coffee and Muse. New mornings without the restarts.**

A friendly workmate for Meta's Muse Code: a chat panel in VS Code, with a brain folder that remembers you and your project, so every session starts where you left off.

Built for the Meta Global AI Developer Hackathon (27 Oct – 4 Nov 2026). Everything in this repo was written during the hackathon.

## Who built what

Meta Betta is built the way it asks you to work: one human steering, AIs doing the grunt work, nothing forgotten between sessions.

- **Bryan (madazz01)** — the idea, the decisions, and every "that's not right" check.
- **Muse Code** (Meta's coding agent, `muse-spark-1.3`) — wrote the extension code, one brief at a time. Its commits end with `Built-by: Muse Code (…)`, and its own session logs for each brief are exported to [`docs/build-log/`](docs/build-log/).
- **Claude Code** (Anthropic) — wrote the build briefs ([`AGENTS.md`](AGENTS.md), [`docs/briefs/`](docs/briefs/)), the early SDK spike ([`spike/`](spike/)), and reviewed each brief's work. Its commits end with `Co-Authored-By: Claude …`.

`git log` shows who did each step.

## Free for everyone

Meta Betta is free and open source under the [MIT licence](LICENSE): use it, change it, share it. You still need Muse Code itself, and Muse usage is billed by Meta as usual (free credits, plan or pay as you go).

Work in progress.
