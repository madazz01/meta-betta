// Pure paste helpers (pictures and files into the chat): no VS Code imports,
// so they can be unit tested with node --test.

/** Pictures per message; the panel caps chips at this. */
export const PASTE_MAX_IMAGES = 4;
/** Longest edge, in px, of a picture sent to Muse. Bigger ones shrink. */
export const PASTE_LONG_EDGE = 1600;
/** A dropped or pasted file over this is skipped with a quiet notice. */
export const PASTE_FILE_MAX_BYTES = 20 * 1024 * 1024;
/** Outside files land here, workspace-relative. */
export const PASTED_DIR = ".meta-betta/pasted";
/** The .gitignore line that keeps the outside copies out of git. */
export const PASTED_GITIGNORE = ".meta-betta/";
/** Text-only turns never change: this text goes out with a picture-only send. */
export const SEE_IMAGE_TEXT = "(see image)";
/** Only these picture types pass; anything else gets the plain error. */
export const PASTE_IMAGE_TYPES = ["image/png", "image/jpeg"] as const;
export type PasteImageType = (typeof PASTE_IMAGE_TYPES)[number];

/** One picture the panel sends with a turn. Bytes stay out of storage. */
export interface PasteImage {
  /** File name for the chat row ("pasted-1.png"). */
  name: string;
  mediaType: PasteImageType;
  /** Raw base64, no data: prefix. */
  base64Data: string;
  width: number;
  height: number;
}

/** Shrink to fit the long edge, keeping the shape. Never enlarges. */
export function resizeDims(width: number, height: number, maxEdge = PASTE_LONG_EDGE): { width: number; height: number } {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    Math.max(width, height) <= maxEdge
  ) {
    return { width, height };
  }
  const scale = maxEdge / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** True for the two picture types Muse takes. WebP and the rest are refused. */
export function isPasteImageType(mediaType: string): mediaType is PasteImageType {
  return (PASTE_IMAGE_TYPES as readonly string[]).includes(mediaType);
}

/**
 * Validate pictures arriving from the panel. Returns the clean list, or
 * undefined when anything is off (too many, wrong type, no bytes, no size).
 */
export function cleanPasteImages(value: unknown): PasteImage[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > PASTE_MAX_IMAGES) {
    return undefined;
  }
  const images: PasteImage[] = [];
  const names = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      return undefined;
    }
    const { name, mediaType, base64Data, width, height } = entry as Record<string, unknown>;
    if (
      typeof name !== "string" ||
      name.trim() === "" ||
      names.has(name) ||
      typeof mediaType !== "string" ||
      !isPasteImageType(mediaType) ||
      typeof base64Data !== "string" ||
      base64Data === "" ||
      typeof width !== "number" ||
      !Number.isInteger(width) ||
      width <= 0 ||
      typeof height !== "number" ||
      !Number.isInteger(height) ||
      height <= 0
    ) {
      return undefined;
    }
    names.add(name);
    images.push({ name, mediaType, base64Data, width, height });
  }
  return images;
}

/** The file names on a turn, for the chat row and the stored transcript. */
export function imageAttachmentNames(images: readonly PasteImage[]): string[] {
  return images.map((image) => image.name);
}

/** A turn's input parts: the text plus the pictures. Text-only when no pictures. */
export function buildTurnInput(
  text: string,
  images: readonly PasteImage[],
): ({ type: "text"; text: string } | { type: "image"; mediaType: PasteImageType; base64Data: string; width: number; height: number })[] {
  if (images.length === 0) {
    return [{ type: "text", text }];
  }
  const first: { type: "text"; text: string } = {
    type: "text",
    text: text.trim() === "" ? SEE_IMAGE_TEXT : text,
  };
  return [
    first,
    ...images.map((image) => ({
      type: "image" as const,
      mediaType: image.mediaType,
      base64Data: image.base64Data,
      width: image.width,
      height: image.height,
    })),
  ];
}

/** Split "shot.png" into "shot" + ".png" (no extension → ""). */
function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return { stem: name, ext: "" };
  }
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * A free name in the pasted folder: "shot.png", then "shot-2.png",
 * "shot-3.png" when taken (including clashes from an earlier save).
 */
export function uniquePastedName(taken: Iterable<string>, name: string): string {
  const used = new Set(taken);
  if (!used.has(name)) {
    return name;
  }
  const { stem, ext } = splitName(name);
  let n = 2;
  while (used.has(`${stem}-${n}${ext}`)) {
    n += 1;
  }
  return `${stem}-${n}${ext}`;
}

/** True when the file fits through paste (20 MB max). */
export function pasteFileFits(size: number): boolean {
  return Number.isFinite(size) && size >= 0 && size <= PASTE_FILE_MAX_BYTES;
}

/** "812K" / "84K" / "3 MB" chip size labels. */
export function formatPasteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)}K`;
  }
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}
