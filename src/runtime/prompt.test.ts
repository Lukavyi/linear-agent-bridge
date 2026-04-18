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
      subjectType: "issue",
      subjectId: "issue-123",
      subjectLabel: "LUK-123 Fix Linear bridge",
      subjectUrl: "https://linear.app/test/issue/LUK-123",
      issueId: "issue-123",
      issueIdentifier: "LUK-123",
      issueTitle: "Fix Linear bridge",
      issueDescription: "",
      issueUrl: "https://linear.app/test/issue/LUK-123",
      projectId: "project-1",
      projectName: "done camp",
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
      subjectType: "issue",
      subjectId: "issue-456",
      subjectLabel: "LUK-456 Investigate prompt hydration",
      subjectUrl: "",
      issueId: "issue-456",
      issueIdentifier: "LUK-456",
      issueTitle: "Investigate prompt hydration",
      issueDescription: "",
      issueUrl: "",
      projectId: "",
      projectName: "",
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

test("buildTurnMessage falls back to project context when there is no issue", () => {
  const message = buildTurnMessage({
    cfg: { defaultDir: "/tmp/default" },
    trigger: {
      source: "comment",
      kind: "Comment",
      action: "prompted",
      sessionId: "session-project-1",
      eventKey: "linear:comment:comment-project-1",
      webhookId: "",
      deliveryId: "delivery-project-1",
      signal: "",
      prompt: "Перевір project comments",
      promptContext: "Project discussion",
      guidance: "",
      subjectType: "project",
      subjectId: "project-1",
      subjectLabel: "linear-agent-bridge + linear-proxy",
      subjectUrl: "https://linear.app/test/project/bridge",
      issueId: "",
      issueIdentifier: "",
      issueTitle: "",
      issueDescription: "",
      issueUrl: "",
      projectId: "project-1",
      projectName: "linear-agent-bridge + linear-proxy",
      teamKey: "LUK",
      projectKey: "bridge",
      commentId: "comment-project-1",
      activityId: "",
    },
    history: [],
  });

  assert.match(message, /- Project: linear-agent-bridge \+ linear-proxy/);
  assert.match(message, /- Subject URL: https:\/\/linear.app\/test\/project\/bridge/);
});
