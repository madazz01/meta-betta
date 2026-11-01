import { describe, it } from "node:test";
import assert from "node:assert/strict";

// scrollFollow.js is shared with the webview, so the test requires it from media/.
const { FOLLOW_PX, distanceFromBottom, shouldFollow } = require("../../media/scrollFollow.js") as {
  FOLLOW_PX: number;
  distanceFromBottom: (scrollHeight: number, scrollTop: number, clientHeight: number) => number;
  shouldFollow: (distance: number, justSent: boolean) => boolean;
};

describe("scrollFollow", () => {
  it("stays within about 60px of the bottom", () => {
    assert.equal(FOLLOW_PX, 60);
    assert.equal(distanceFromBottom(1000, 900, 100), 0);
    assert.equal(distanceFromBottom(1000, 800, 100), 100);
  });

  it("follows at the bottom or right after sending", () => {
    assert.equal(shouldFollow(0, false), true);
    assert.equal(shouldFollow(60, false), true);
    assert.equal(shouldFollow(61, false), false);
    assert.equal(shouldFollow(500, false), false);
    assert.equal(shouldFollow(500, true), true);
  });
});
