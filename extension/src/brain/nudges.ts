// Nudge ideas: things Muse can offer ("did you know I can also…?"), each
// with when it fits. Only things that work right now, in plain words —
// nothing that needs a button or slash command we haven't built yet (those
// join the list with brief 08). Shown to Muse as hints in the front door.

export interface NudgeIdea {
  /** Fits "Did you know I can also <thing>?" */
  thing: string;
  /** When offering it makes sense. */
  when: string;
}

export const NUDGE_IDEAS: NudgeIdea[] = [
  {
    thing: "undo any reply that changed files — just hit ↩ under it",
    when: "the first time a reply changes files, or when they say something broke",
  },
  {
    thing: "split a big job across helpers (say 'use a workflow')",
    when: "a big job that splits up: an audit, a migration, a broad review",
  },
  {
    thing: "watch a long build or log and tell you when it changes",
    when: "a long build or log is running",
  },
  {
    thing: "answer a quick side question without losing our place",
    when: "they ask something off-topic in the middle of a job",
  },
  {
    thing: "read a screenshot or photo",
    when: "they mention a screenshot, photo, or picture",
  },
  {
    thing: "turn a voice note into a list (Alt+V in the Muse terminal)",
    when: "typing it all out would be a chore",
  },
  {
    thing: "write tests for it",
    when: "something just started working",
  },
  {
    thing: "explain an error in plain words",
    when: "an error or stack trace shows up",
  },
  {
    thing: "make a one-page HTML file instead of a server",
    when: "they want to see or share something quickly",
  },
  {
    thing: "summarise a long file",
    when: "they're facing a long file or log",
  },
  {
    thing: "find where something is used",
    when: "they're about to change shared code, or ask what uses something",
  },
];

/** One "- <thing> (when: <when>)" line per idea, for the front door. */
export function nudgeHintsText(): string {
  return NUDGE_IDEAS.map((idea) => `- ${idea.thing} (when: ${idea.when})`).join("\n");
}
