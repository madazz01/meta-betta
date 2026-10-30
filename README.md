# Meta Betta — we just made it play nice

**Coffee and Muse. New mornings without the restarts.** Start the day with a colleague, not a tool.

A friendly workmate for Meta's Muse Code: a chat panel in VS Code, with a brain folder that remembers you and your project, so every session starts where you left off.

Built for the Meta Global AI Developer Hackathon (27 Oct – 4 Nov 2026). Everything in this repo was written during the hackathon.

## Why I entered

The prize money would be lovely, not gonna lie. But that's not really why I do hackathons. I like pushing myself to hit a goal with a hard deadline, and seeing what I can actually create in that time. A focused time limit is the best way I know to test myself.

9 months in since the first time I ever used AI and counting.

## Who built what

Meta Betta is built the way it asks you to work: one human steering, AIs doing the grunt work, nothing forgotten between sessions.

- **Bryan (madazz01)** — the idea, the decisions, and every "that's not right" check.
- **Muse Code** (Meta's coding agent, `muse-spark-1.3`) — wrote the extension code, one brief at a time. Its commits end with `Built-by: Muse Code (…)`, and its own session logs for each brief are exported to [`docs/build-log/`](docs/build-log/).
- **Claude Code** (Anthropic) — wrote the build briefs ([`AGENTS.md`](AGENTS.md), [`docs/briefs/`](docs/briefs/)), the early SDK spike ([`spike/`](spike/)), and reviewed each brief's work. Its commits end with `Co-Authored-By: Claude …`.

`git log` shows who did each step.

## What we found while building

Driving Muse through its SDK every day threw up a few hurdles: a Windows sandbox bug in serve mode (and a safe workaround), how to build a real Stop button, and a notification gotcha. All written up with repro scripts in [`WHAT-WE-FOUND.md`](WHAT-WE-FOUND.md).

## Free for everyone

Meta Betta is free and open source under the [MIT licence](LICENSE): use it, change it, share it. You still need Muse Code itself, and Muse usage is billed by Meta as usual (free credits, plan or pay as you go).

Work in progress.
