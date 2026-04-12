import test from "node:test";
import assert from "node:assert/strict";

import {
  isSelfAuthoredComment,
  shouldSkipPromptedRun,
} from "./skip-filter.js";

test("shouldSkipPromptedRun skips known Linear system echo messages", () => {
  assert.equal(shouldSkipPromptedRun("Working 12:34"), "system-echo");
  assert.equal(shouldSkipPromptedRun("thinking 09:07"), "system-echo");
  assert.equal(shouldSkipPromptedRun("Stop request received"), "system-echo");
  assert.equal(shouldSkipPromptedRun("Привіт"), "");
});

test("isSelfAuthoredComment does not skip normal human comments", async () => {
  const result = await isSelfAuthoredComment({} as never, {} as never, {
    user: { id: "user-1", name: "Jane Doe" },
  });

  assert.equal(result, false);
});

test("isSelfAuthoredComment detects synthetic bot-authored comments", async () => {
  const artificial = await isSelfAuthoredComment({} as never, {} as never, {
    isArtificialAgentSessionRoot: true,
  });
  const botComment = await isSelfAuthoredComment({} as never, {} as never, {
    comment: { botActor: { id: "bot-1" } },
  });

  assert.equal(artificial, true);
  assert.equal(botComment, true);
});

test("isSelfAuthoredComment detects visible OpenClaw response comments", async () => {
  const result = await isSelfAuthoredComment({} as never, {} as never, {
    comment: {
      user: { id: "openclaw-user", name: "OpenClaw" },
    },
  });

  assert.equal(result, true);
});
