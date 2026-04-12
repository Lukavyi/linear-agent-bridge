import test from "node:test";
import assert from "node:assert/strict";

import { buildExtraSystemPrompt, buildTurnMessage } from "./prompt.js";

test("buildExtraSystemPrompt uses one stable contract without turn-mode heuristics", () => {
  const prompt = buildExtraSystemPrompt();

  assert.match(prompt, /Default to a direct conversational answer\./);
  assert.match(prompt, /Only take agentic actions, edit files, or run commands when the user's current turn explicitly asks for that work\./);
  assert.doesNotMatch(prompt, /chat mode/i);
  assert.doesNotMatch(prompt, /task mode/i);
});

test("buildTurnMessage includes history, workspace, and current turn", () => {
  const message = buildTurnMessage({
    cfg: {
      defaultDir: "/tmp/default",
      repoByProject: { "done-camp": "/repos/done_camp" },
    },
    trigger: {
      source: "agent-session",
      kind: "AgentSessionEvent",
      action: "prompted",
      sessionId: "session-123",
      eventKey: "linear:activity:activity-123",
      webhookId: "",
      deliveryId: "delivery-123",
      signal: "",
      prompt: "Пофікси будь ласка Linear bridge",
      promptContext: "Issue discussion",
      guidance: "Keep it concise",
      issueId: "issue-123",
      issueIdentifier: "LUK-123",
      issueTitle: "Fix Linear bridge",
      issueDescription: "",
      issueUrl: "https://linear.app/test/issue/LUK-123",
      teamKey: "LUK",
      projectKey: "done-camp",
      commentId: "",
      activityId: "activity-123",
    },
    history: [
      { type: "thought", text: "Received an update on LUK-123" },
      { type: "prompt", text: "Пофікси будь ласка Linear bridge" },
    ],
  });

  assert.match(message, /Linear AgentSession and AgentActivity are the source of truth/);
  assert.match(message, /Suggested workspace: \/repos\/done_camp/);
  assert.match(message, /Recent AgentActivity history:/);
  assert.match(message, /Current user turn:\nПофікси будь ласка Linear bridge/);
  assert.doesNotMatch(message, /This is chat mode/i);
  assert.doesNotMatch(message, /This is task mode/i);
});
