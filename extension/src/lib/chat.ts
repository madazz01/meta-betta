// Pure chat logic: no VS Code imports, so it can be unit tested with node --test.

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

/** True when the text has something to send (not blank). */
export function canSend(text: string): boolean {
  return text.trim().length > 0;
}

/** Append a message, returning a new list (does not mutate the input). */
export function appendMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  return [...messages, message];
}

/** Fake assistant reply used until the chat is wired to Muse Code. */
export function formatEcho(text: string): string {
  return `Echo: ${text}`;
}

/**
 * Validate an unknown webview message. Returns the trimmed text to answer,
 * or undefined when the message isn't a sendable "send" message.
 */
export function parseSendMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { type, text } = value as { type?: unknown; text?: unknown };
  if (type !== "send" || typeof text !== "string") {
    return undefined;
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface NudgeAnswer {
  /** Assistant message id the card belongs to. */
  id: string;
  answer: "show" | "notnow";
  /** The offered thing, for the me.md decline note (may be empty). */
  thing: string;
}

/**
 * Validate a nudge card button press from the panel. Returns the answer, or
 * undefined when the message isn't a well-formed "nudgeAnswer" message.
 */
export function parseNudgeAnswer(value: unknown): NudgeAnswer | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { type, id, answer, thing } = value as {
    type?: unknown;
    id?: unknown;
    answer?: unknown;
    thing?: unknown;
  };
  if (type !== "nudgeAnswer" || typeof id !== "string" || id === "") {
    return undefined;
  }
  if (answer !== "show" && answer !== "notnow") {
    return undefined;
  }
  if (thing !== undefined && typeof thing !== "string") {
    return undefined;
  }
  return { id, answer, thing: (thing ?? "").trim() };
}

export interface CardButtonPress {
  cardId: string;
  buttonId: string;
}

/** Validate a result-card button press from the panel. */
export function parseCardButton(value: unknown): CardButtonPress | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { type, cardId, buttonId } = value as { type?: unknown; cardId?: unknown; buttonId?: unknown };
  if (
    type !== "cardButton" ||
    typeof cardId !== "string" ||
    cardId === "" ||
    typeof buttonId !== "string" ||
    buttonId === ""
  ) {
    return undefined;
  }
  return { cardId, buttonId };
}

export interface CardInputAnswer {
  cardId: string;
  inputId: string;
  text: string;
}

/** Validate a result-card input answer from the panel. */
export function parseCardInput(value: unknown): CardInputAnswer | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { type, cardId, inputId, text } = value as {
    type?: unknown;
    cardId?: unknown;
    inputId?: unknown;
    text?: unknown;
  };
  if (
    type !== "cardInput" ||
    typeof cardId !== "string" ||
    cardId === "" ||
    typeof inputId !== "string" ||
    inputId === "" ||
    typeof text !== "string"
  ) {
    return undefined;
  }
  return { cardId, inputId, text };
}
