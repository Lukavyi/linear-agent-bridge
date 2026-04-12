import test from "node:test";
import assert from "node:assert/strict";

import { buildToolTraceActivities } from "./tool-trace.js";

test("builds visible tool trace activities from tool calls and results", () => {
  const activities = buildToolTraceActivities(
    [
      {
        role: "assistant",
        timestamp: "2026-04-12T12:00:01.000Z",
        content: [
          {
            type: "toolCall",
            id: "call-read",
            name: "read",
            arguments: { path: "/Users/example/git_repos/acme/linear-agent-bridge/src/runtime/handler.ts" },
          },
          {
            type: "toolCall",
            id: "call-search",
            name: "web_search",
            arguments: { query: "linear duplicate follow-up bug" },
          },
        ],
      },
      {
        role: "toolResult",
        timestamp: "2026-04-12T12:00:02.000Z",
        toolCallId: "call-read",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
      },
      {
        role: "toolResult",
        timestamp: "2026-04-12T12:00:02.100Z",
        toolCallId: "call-search",
        toolName: "web_search",
        details: { status: "error", error: "429 rate limited" },
        content: [{ type: "text", text: "{\"status\":\"error\",\"error\":\"429 rate limited\"}" }],
      },
    ],
    { startedAtMs: Date.parse("2026-04-12T12:00:00.500Z") },
  );

  assert.equal(activities.length, 1);
  assert.equal(activities[0]?.type, "thought");
  assert.match(activities[0]?.body ?? "", /read ~\/git_repos\/acme\/linear-agent-bridge\/src\/runtime\/handler\.ts/);
  assert.match(activities[0]?.body ?? "", /web_search "linear duplicate follow-up bug" -> error: 429 rate limited/);
});

test("skips tool calls that happened before the current run window", () => {
  const activities = buildToolTraceActivities(
    [
      {
        role: "assistant",
        timestamp: "2026-04-12T11:59:58.000Z",
        content: [
          {
            type: "toolCall",
            id: "call-old",
            name: "read",
            arguments: { path: "/Users/example/old.ts" },
          },
        ],
      },
      {
        role: "assistant",
        timestamp: "2026-04-12T12:00:01.000Z",
        content: [
          {
            type: "toolCall",
            id: "call-new",
            name: "read",
            arguments: { path: "/Users/example/new.ts" },
          },
        ],
      },
    ],
    { startedAtMs: Date.parse("2026-04-12T12:00:00.500Z") },
  );

  const body = activities[0]?.body ?? "";
  assert.match(body, /read ~\/new\.ts/);
  assert.doesNotMatch(body, /old\.ts/);
});
