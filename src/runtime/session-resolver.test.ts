import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveSessionId,
  shouldDeferRootCommentCreateToNativeSession,
} from "./session-resolver.js";

test("resolveSessionId prefers direct session fields", () => {
  assert.equal(
    resolveSessionId({ agentSessionId: "session-1" }),
    "session-1",
  );

  assert.equal(
    resolveSessionId({ agentSession: { id: "session-2" } }),
    "session-2",
  );
});

test("resolveSessionId falls back through activity and comment fields", () => {
  assert.equal(
    resolveSessionId({
      agentActivity: {
        agentSessionId: "session-3",
      },
    }),
    "session-3",
  );

  assert.equal(
    resolveSessionId({
      comment: {
        agentSession: { id: "session-4" },
      },
    }),
    "session-4",
  );
});

test("defers top-level comment creates to native session creation", () => {
  assert.equal(
    shouldDeferRootCommentCreateToNativeSession({
      isCreate: true,
      parentId: "",
    }),
    true,
  );

  assert.equal(
    shouldDeferRootCommentCreateToNativeSession({
      isCreate: true,
      parentId: "comment-parent-1",
    }),
    false,
  );

  assert.equal(
    shouldDeferRootCommentCreateToNativeSession({
      isCreate: false,
      parentId: "",
    }),
    false,
  );
});
