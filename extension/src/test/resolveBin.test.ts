import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveMuseBin } from "../muse/resolveBin.js";

const MUSE_DIR = "C:\\Users\\sam\\AppData\\Local\\Programs\\muse";

describe("resolveMuseBin", () => {
  it("prefers the setting over everything else", () => {
    assert.equal(
      resolveMuseBin({ setting: "D:\\tools\\muse.exe", museDir: MUSE_DIR, dirFiles: ["muse-bin-1.4.14.exe"] }),
      "D:\\tools\\muse.exe",
    );
  });

  it("ignores a blank setting", () => {
    assert.equal(resolveMuseBin({ setting: "   ", museDir: MUSE_DIR, dirFiles: [] }), "muse");
  });

  it("picks the newest installed binary by version", () => {
    assert.equal(
      resolveMuseBin({
        setting: "",
        museDir: MUSE_DIR,
        dirFiles: ["muse-bin-1.4.2.exe", "muse-bin-1.4.14.exe", "muse-bin-1.4.9.exe"],
      }),
      `${MUSE_DIR}\\muse-bin-1.4.14.exe`,
    );
  });

  it("treats missing segments as zero", () => {
    assert.equal(
      resolveMuseBin({ setting: "", museDir: MUSE_DIR, dirFiles: ["muse-bin-1.4.exe", "muse-bin-1.4.1.exe"] }),
      `${MUSE_DIR}\\muse-bin-1.4.1.exe`,
    );
  });

  it("ignores files that are not versioned binaries", () => {
    assert.equal(
      resolveMuseBin({
        setting: "",
        museDir: MUSE_DIR,
        dirFiles: ["muse.exe", "notes.txt", "muse-bin-old", "muse-bin-1.2.exe.bak"],
      }),
      "muse",
    );
  });

  it("falls back to muse on PATH when nothing is installed", () => {
    assert.equal(resolveMuseBin({ setting: "", museDir: MUSE_DIR, dirFiles: [] }), "muse");
    assert.equal(resolveMuseBin({ museDir: MUSE_DIR, dirFiles: [] }), "muse");
  });
});
