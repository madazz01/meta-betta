import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSendWithImages } from "../lib/chat.js";
import {
  buildTurnInput,
  cleanPasteImages,
  formatPasteSize,
  isPasteImageType,
  pasteFileFits,
  resizeDims,
  SEE_IMAGE_TEXT,
  uniquePastedName,
  type PasteImage,
} from "../lib/paste.js";
import { ensureGitignoreEntry, type BrainFs } from "../brain/brain.js";
import { insideDir } from "../lib/approvals.js";
import { buildForkTranscript, buildTranscript } from "../lib/session.js";

function image(name = "pasted-1.png"): PasteImage {
  return { name, mediaType: "image/png", base64Data: "aGVsbG8=", width: 64, height: 64 };
}

describe("uniquePastedName", () => {
  it("keeps the name when free", () => {
    assert.equal(uniquePastedName([], "shot.png"), "shot.png");
  });

  it("a clash leads to -2, then -3", () => {
    assert.equal(uniquePastedName(["shot.png"], "shot.png"), "shot-2.png");
    assert.equal(uniquePastedName(["shot.png", "shot-2.png"], "shot.png"), "shot-3.png");
  });

  it("handles names without an extension", () => {
    assert.equal(uniquePastedName(["notes"], "notes"), "notes-2");
  });
});

describe("pasted gitignore line", () => {
  function fakeFs(files: Record<string, string>): { fs: BrainFs; written: Record<string, string> } {
    const written: Record<string, string> = {};
    const fs: BrainFs = {
      exists: async (target) => target in files || target in written,
      mkdir: async () => undefined,
      readFile: async (target) => files[target] ?? written[target] ?? "",
      writeFile: async (target, content) => {
        written[target] = content;
      },
      appendFile: async (target, content) => {
        written[target] = `${written[target] ?? ""}${content}`;
      },
      mtimeMs: async () => undefined,
    };
    return { fs, written };
  }

  it("adds the line once, never twice", async () => {
    const first = fakeFs({});
    assert.equal(await ensureGitignoreEntry("c:\\ws", ".meta-betta/", first.fs), true);
    assert.deepEqual(first.written, { "c:\\ws\\.gitignore": ".meta-betta/\n" });
    // Second run sees the line from the first write: untouched.
    const again = fakeFs({ "c:\\ws\\.gitignore": ".meta-betta/\n" });
    assert.equal(await ensureGitignoreEntry("c:\\ws", ".meta-betta/", again.fs), false);
    assert.deepEqual(again.written, {});
  });

  it("leaves the file untouched when the line is already there", async () => {
    const { fs, written } = fakeFs({ "c:\\ws\\.gitignore": "node_modules/\n.meta-betta/\n" });
    assert.equal(await ensureGitignoreEntry("c:\\ws", ".meta-betta/", fs), false);
    assert.deepEqual(written, {});
  });
});

describe("inside workspace rule", () => {
  const root = "c:\\ws";
  it("a workspace file stays where it is", () => {
    assert.equal(insideDir(root, root, "c:\\ws\\notes.txt"), true);
    assert.equal(insideDir(root, root, "notes.txt"), true);
  });

  it("an outside file does not", () => {
    assert.equal(insideDir(root, root, "c:\\other\\shot.png"), false);
    assert.equal(insideDir(root, root, "..\\escape.txt"), false);
  });
});

describe("resizeDims", () => {
  it("a giant picture shrinks to the long edge", () => {
    assert.deepEqual(resizeDims(4000, 3000), { width: 1600, height: 1200 });
  });

  it("portrait keeps its shape", () => {
    assert.deepEqual(resizeDims(1000, 4000), { width: 400, height: 1600 });
  });

  it("small pictures are never enlarged", () => {
    assert.deepEqual(resizeDims(800, 600), { width: 800, height: 600 });
    assert.deepEqual(resizeDims(1600, 1600), { width: 1600, height: 1600 });
  });
});

describe("buildTurnInput", () => {
  it("text parts only when no images", () => {
    assert.deepEqual(buildTurnInput("hi", []), [{ type: "text", text: "hi" }]);
  });

  it("text plus images, width with height", () => {
    const parts = buildTurnInput("look", [image("a.png"), image("b.png")]);
    assert.equal(parts.length, 3);
    assert.deepEqual(parts[0], { type: "text", text: "look" });
    assert.deepEqual(parts[1], {
      type: "image",
      mediaType: "image/png",
      base64Data: "aGVsbG8=",
      width: 64,
      height: 64,
    });
  });

  it("a picture with no words sends (see image)", () => {
    assert.deepEqual(buildTurnInput("   ", [image()]), [
      { type: "text", text: SEE_IMAGE_TEXT },
      {
        type: "image",
        mediaType: "image/png",
        base64Data: "aGVsbG8=",
        width: 64,
        height: 64,
      },
    ]);
  });
});

describe("cleanPasteImages", () => {
  it("takes up to four PNG or JPEG pictures", () => {
    const images = [image("a.png"), { ...image("b.jpg"), mediaType: "image/jpeg" as const }];
    assert.deepEqual(cleanPasteImages(images), images);
  });

  it("refuses WebP and anything over four", () => {
    assert.equal(cleanPasteImages([{ ...image(), mediaType: "image/webp" }]), undefined);
    assert.equal(
      cleanPasteImages([image("1.png"), image("2.png"), image("3.png"), image("4.png"), image("5.png")]),
      undefined,
    );
  });

  it("refuses missing bytes or sizes", () => {
    assert.equal(cleanPasteImages([{ ...image(), base64Data: "" }]), undefined);
    assert.equal(cleanPasteImages([{ ...image(), width: 0 }]), undefined);
    assert.equal(cleanPasteImages([{ ...image(), mediaType: "image/pngx" }]), undefined);
  });
});

describe("parseSendWithImages", () => {
  it("a picture with no words is sendable", () => {
    const parsed = parseSendWithImages({ type: "send", text: "   ", images: [image()] });
    assert.deepEqual(parsed, { text: "", images: [image()] });
  });

  it("blank text with no pictures is not", () => {
    assert.equal(parseSendWithImages({ type: "send", text: "   " }), undefined);
  });
});

describe("picture transcripts", () => {
  it("a picture with no words still replays, with its names", () => {
    const stored = buildTranscript([{ type: "user", text: "", attachments: ["a.png"] }]);
    assert.deepEqual(stored, [{ role: "user", text: "", attachments: ["a.png"] }]);
  });

  it("a fork keeps the names too", () => {
    const stored = buildForkTranscript([{ type: "user", text: "", attachments: ["a.png"] }]);
    assert.deepEqual(stored, [{ role: "user", text: "", attachments: ["a.png"] }]);
  });

  it("plain words replay with no attachments key", () => {
    const stored = buildTranscript([{ type: "user", text: "hi" }]);
    assert.deepEqual(stored, [{ role: "user", text: "hi" }]);
  });
});

describe("paste limits", () => {
  it("files fit up to 20 MB", () => {
    assert.equal(pasteFileFits(20 * 1024 * 1024), true);
    assert.equal(pasteFileFits(20 * 1024 * 1024 + 1), false);
  });

  it("only PNG and JPEG pass the type check", () => {
    assert.equal(isPasteImageType("image/png"), true);
    assert.equal(isPasteImageType("image/jpeg"), true);
    assert.equal(isPasteImageType("image/webp"), false);
    assert.equal(isPasteImageType("image/gif"), false);
  });

  it("chip sizes read plainly", () => {
    assert.equal(formatPasteSize(812 * 1024), "812K");
    assert.equal(formatPasteSize(84 * 1024), "84K");
  });
});
