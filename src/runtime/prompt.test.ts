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

test("buildTurnMessage includes compact issue context, history, workspace, and current turn", () => {
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
      promptContext: "Huge XML blob that should not leak through",
      guidance: "Keep it concise",
      issueId: "issue-123",
      issueIdentifier: "LUK-123",
      issueTitle: "Fix Linear bridge",
      issueDescription: "Only include the useful issue summary",
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
    issueComments: [
      { author: "Taras Lukavyi", text: "Не давай весь паралельний agent spam у prompt" },
    ],
  });

  assert.match(message, /Linear AgentSession and AgentActivity are the source of truth/);
  assert.match(message, /Suggested workspace: \/repos\/done_camp/);
  assert.match(message, /Issue context:/);
  assert.match(message, /Only include the useful issue summary/);
  assert.match(message, /Taras Lukavyi: Не давай весь паралельний agent spam у prompt/);
  assert.match(message, /Recent AgentActivity history:/);
  assert.match(message, /Current user turn:\nПофікси будь ласка Linear bridge/);
  assert.doesNotMatch(message, /Huge XML blob that should not leak through/);
  assert.doesNotMatch(message, /This is chat mode/i);
  assert.doesNotMatch(message, /This is task mode/i);
});

test("buildTurnMessage falls back to latest prompt activity when webhook prompt is empty", () => {
  const message = buildTurnMessage({
    cfg: { defaultDir: "/tmp/default" },
    trigger: {
      source: "agent-session",
      kind: "AgentSessionEvent",
      action: "prompted",
      sessionId: "session-456",
      eventKey: "linear:activity:activity-456",
      webhookId: "",
      deliveryId: "delivery-456",
      signal: "",
      prompt: "",
      promptContext: "",
      guidance: "",
      issueId: "issue-456",
      issueIdentifier: "LUK-456",
      issueTitle: "Investigate prompt hydration",
      issueDescription: "",
      issueUrl: "",
      teamKey: "LUK",
      projectKey: "",
      commentId: "",
      activityId: "activity-456",
    },
    history: [
      { type: "response", text: "Попередня відповідь" },
      { type: "prompt", text: "Ні, давай йти до сліди" },
      { type: "thought", text: "Received your follow-up. Thinking now." },
    ],
  });

  assert.match(message, /Current user turn:\nНі, давай йти до сліди/);
  assert.doesNotMatch(message, /No direct prompt body was included in the webhook/);
});
