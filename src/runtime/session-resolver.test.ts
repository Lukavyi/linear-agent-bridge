import test from "node:test";
import assert from "node:assert/strict";

import { resolveSessionId } from "./session-resolver.js";

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
