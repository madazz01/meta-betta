# Brief 07 — Plain handovers + "did you know I can also…?"

Read `AGENTS.md` first. Briefs 01–06 must be done.

## Goal
Muse always finishes a job in plain words, and now and then suggests one useful thing it can do that the user hasn't tried, at the right moment.

## Build
1. Extend the front-door section (brain.ts template; bump a version marker inside the meta-betta section so existing workspaces get the update):
   - **Handover rule:** end every job with "**Done:** …", "**To use it:** …" (click by click, simplest way first, e.g. "double-click index.html"), "**I couldn't check:** …". No code dumps unless asked.
   - **Nudge rule:** at most one per session, only right after a job that went well, only if relevant to what they just did, and never something listed in brain/good-for.md. Format: "💡 Did you know I can also <thing>? Want me to show you on <their actual file>?" If they say no, add "not interested: <thing>" to brain/me.md and never suggest it again.
2. In the panel, render a 💡 nudge as a small card with [Show me] [Not now] buttons that send those answers back as the user's reply.
3. Seed list of nudge ideas in `extension/src/brain/nudges.ts` (start from the "when it helps" column in [`docs/muse-features.md`](../muse-features.md): goal, side question, fork, workflows, monitor, background, skills, effort, usage, export, voice, image paste, @ mentions, plus the ones below) (plain English, each with "when it's relevant"), included in the front door as hints, e.g.: read a screenshot/photo, turn a voice note into a list (Alt+V in Muse), write tests, explain an error in plain words, make a one-page HTML instead of a server, summarise a long file, find where something is used, and **undo** ("You can undo any reply that changed files, just hit ↩ under it": show it the first time a reply changes files, and again after the user says something like "that broke it").

4. **Times for scrolling back:** every message (yours and Muse's) shows a small, dim time under it (`9:41 AM`), and a day divider appears whenever the date changes between messages (`── Wed 29 Oct ──`). Times are stored with the history, so a resumed chat shows the real times, not the replay time. Test the divider logic (same day, next day, a gap of a week).

## Done when
- After a small job, the reply ends with Done / To use it / I couldn't check.
- Within a session, at most one 💡 card appears, and "Not now" stops it reappearing.

## Handover
Plain English + commit `07: plain handovers and nudges`.
