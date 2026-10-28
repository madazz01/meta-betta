// Pure approval helpers: plain-English card titles and the safest-choice
// fallback used when the panel is closed. No VS Code imports.

export interface ApprovalChoiceView {
  choiceId: string;
  decision: string;
  label: string;
}

export interface ApprovalSubjectView {
  kind: string;
  command?: string;
  access?: string;
  host?: string;
  port?: number;
  protocol?: string;
  path?: string;
  target?: string;
  toolName?: string;
}

export interface ApprovalCard {
  title: string;
  detail?: string;
}

/** Plain-English card for an approval request. Unknown kinds stay generic. */
export function approvalCard(
  subject: ApprovalSubjectView,
  toolName: string,
  rawArgs: string,
): ApprovalCard {
  switch (subject.kind) {
    case "shell":
      return {
        title: "Muse wants to run a command",
        detail: truncate(subject.command ?? "", 300) || undefined,
      };
    case "fileAccess": {
      const verb = subject.access === "write" ? "change" : subject.access === "read" ? "read" : "open";
      return { title: `Muse wants to ${verb} a file`, detail: subject.path };
    }
    case "network": {
      const where = subject.host
        ? `${subject.protocol ?? "https"}://${subject.host}${subject.port ? `:${subject.port}` : ""}`
        : undefined;
      return { title: "Muse wants to reach the network", detail: where };
    }
    case "process":
      return { title: "Muse wants to control a process", detail: subject.target };
    default: {
      const who = subject.toolName ?? toolName;
      return {
        title: who ? `Muse wants to use ${who}` : "Muse wants your permission",
        detail: truncate(rawArgs, 200) || undefined,
      };
    }
  }
}

/**
 * The safest offered choice: a denial first, then abort, else the first
 * choice. Used when the panel is closed and the user can't click.
 */
export function safestChoiceId(choices: ApprovalChoiceView[]): string | undefined {
  return (
    choices.find((choice) => choice.decision === "denied")?.choiceId ??
    choices.find((choice) => choice.decision.startsWith("denied"))?.choiceId ??
    choices.find((choice) => choice.decision === "abort")?.choiceId ??
    choices[0]?.choiceId
  );
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
