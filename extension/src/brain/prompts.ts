// The words we send Muse when saving. Kept here so they're easy to tune.
// The extension files the reply into brain/ itself; Muse never edits files.

/** Full save: every section, filed by splitSaveReply. */
export const SAVE_MY_DAY_PROMPT = `Save my day. Don't edit any files. Reply with ONLY these sections (skip any that are empty), plain English, short bullet points:
## project
Where we're up to, what works, what's next, any open problems.
## log
What we did in this session.
## tricks
Any workaround that worked (one line each).
## good-for
Anything new you did for me (e.g. "Read a photo of a receipt").
## me
Anything new you learned about how I like to work.`;

/** Quick save: project + log only, appended the same way. */
export const QUICK_SAVE_PROMPT = `Quick save. Don't edit any files. Reply with ONLY these sections (skip any that are empty), plain English, short bullet points:
## project
Where we're up to, what works, what's next.
## log
What we did since the last save.`;

/** True when a history message is one of our save prompts (never shown). */
export function isSavePrompt(text: string): boolean {
  const clean = text.trim();
  return clean === SAVE_MY_DAY_PROMPT || clean === QUICK_SAVE_PROMPT;
}

/**
 * Welcome script: Muse asks the name, then the project, one per reply. The
 * extension files the answers itself (name line, START HERE) and shows the
 * memory message after — Muse just keeps it warm and brief.
 */
export const WELCOME_PROMPT = `This is the first-time welcome. Ignore the 'Here's where we're up to' rule for now and follow these steps.
Welcome script. Run it one step at a time, one question per reply, waiting for the user each step. Don't edit any files. If they dodge a question, roll with it warmly and move on.
Step 1 — start with exactly this line: "G'day! What should I call you?"
Step 2 — when they answer, greet them by name if they gave one, then ask: "What are we working on in this folder?"
Step 3 — when they answer that, play it back in one line (what it is, briefly), and stop there.
Keep every reply to one or two short lines. Don't explain how the memory works.`;

/** The one short memory message, shown by the extension after the welcome. */
export const WELCOME_MEMORY_TEXT =
  "Quick one on how I remember: notes on you and this project live in `brain/` (the Brain panel; edit anything). " +
  "I quick-save as we go, and 💾 **Save my day** writes up where we're up to. " +
  "Close everything whenever; next time I start with 'Here's where we're up to'.";

/** Behind the "How does this work?" link under the memory message. */
export const WELCOME_MEMORY_DETAIL =
  "Your brain is stored in this project, on your machine, and it's yours: easy to find, share, move or back up " +
  "(set a backup folder in Settings). I read it each session so I can help, and on a contributor model Meta may use " +
  "what I read, so keep passwords and keys out of it.\n\n" +
  "Quick saves only touch the project notes and today's log — the rest changes only when you press Save my day.";
