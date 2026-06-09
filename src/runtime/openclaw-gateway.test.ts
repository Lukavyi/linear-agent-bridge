import test from "node:test";
import assert from "node:assert/strict";

import { extractVisibleReply } from "./openclaw-gateway.js";

test("joins payload text parts with blank lines", () => {
  assert.equal(
    extractVisibleReply({
      result: { payloads: [{ text: "hello" }, { text: "world" }] },
    }),
    "hello\n\nworld",
  );
});

test("appends media references and dedupes them", () => {
  assert.equal(
    extractVisibleReply({
      result: {
        payloads: [
          { text: "see", mediaUrl: "http://x/1.png" },
          { mediaUrls: ["http://x/1.png", "http://x/2.png"] },
        ],
      },
    }),
    "see\n\nMedia: http://x/1.png\n\nMedia: http://x/2.png",
  );
});

test("treats a NO_REPLY marker as no visible reply", () => {
  assert.equal(
    extractVisibleReply({ result: { payloads: [{ text: "NO_REPLY" }] } }),
    "",
  );
});

test("returns empty string for missing or empty payloads", () => {
  assert.equal(extractVisibleReply(null), "");
  assert.equal(extractVisibleReply({}), "");
  assert.equal(extractVisibleReply({ result: { payloads: [] } }), "");
});
