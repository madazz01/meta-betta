// Pure startup helpers: classifying spawn failures and reading the sandbox
// check. No VS Code imports, no child processes (those live in museHost).

/** True when `muse sandbox windows check` output reports the sandbox ready. */
export function parseSandboxReady(output: string): boolean {
  return /\bstatus\s*=\s*ready\b/i.test(output);
}

export type SpawnProblem = "missing" | "login" | "other";

/**
 * Classify a `MuseClient.spawn` / `startSession` failure so the panel can show
 * the right friendly card: "missing" (not installed), "login" (not logged in),
 * or "other" (caller runs the sandbox check next).
 */
export function classifySpawnError(error: unknown): SpawnProblem {
  if (isMissingBinary(error)) {
    return "missing";
  }
  if (mentionsLogin(errorText(error))) {
    return "login";
  }
  return "other";
}

/** First line of an error, bounded — safe to show after "Something went wrong: ". */
export function shortReason(error: unknown, maxLength = 160): string {
  const message = errorText(error).replace(/\s+/g, " ").trim();
  if (!message) {
    return "it didn't say why";
  }
  return message.length > maxLength ? `${message.slice(0, maxLength - 1)}…` : message;
}

function isMissingBinary(error: unknown): boolean {
  for (const node of errorChain(error)) {
    if (typeof node !== "object" || node === null) {
      continue;
    }
    const withCode = node as { code?: unknown; failure?: unknown };
    // A raw Node spawn error, or the SDK's typed spawnFailed arm.
    if (withCode.code === "ENOENT") {
      return true;
    }
    if (typeof withCode.failure === "object" && withCode.failure !== null) {
      const failure = withCode.failure as { kind?: unknown; error?: unknown };
      if (
        failure.kind === "spawnFailed" &&
        typeof failure.error === "object" &&
        failure.error !== null &&
        (failure.error as { code?: unknown }).code === "ENOENT"
      ) {
        return true;
      }
    }
    if (/\bENOENT\b/i.test(errorMessage(node))) {
      return true;
    }
  }
  return false;
}

/** The error plus every `cause` behind it, without looping on cycles. */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function mentionsLogin(text: string): boolean {
  return /\b(auth|login|logged in|sign in|unauthorized|unauthenticated)\b/i.test(text);
}

function errorText(error: unknown): string {
  return errorChain(error)
    .map((node) => {
      const tail = stderrTail(node);
      const message = errorMessage(node);
      return tail ? `${message}\n${tail}` : message;
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "";
}

function stderrTail(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }
  const tail = (error as { stderrTail?: unknown }).stderrTail;
  if (Array.isArray(tail) && tail.every((line): line is string => typeof line === "string")) {
    return tail.join("\n");
  }
  return "";
}
