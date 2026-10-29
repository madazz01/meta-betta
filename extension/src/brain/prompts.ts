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
