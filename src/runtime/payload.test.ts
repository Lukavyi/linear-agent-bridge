import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeLinearWebhookPayload,
  parseLinearTrigger,
} from "./payload.js";

test("normalizeLinearWebhookPayload merges nested data onto root", () => {
  const payload = normalizeLinearWebhookPayload({
    type: "Comment",
    linearDelivery: "delivery-1",
    data: {
      action: "create",
      comment: { id: "comment-1", body: "@openclaw привіт" },
    },
  });

  assert.equal(payload.type, "Comment");
  assert.equal(payload.action, "create");
  assert.deepEqual(payload.comment, { id: "comment-1", body: "@openclaw привіт" });
});

test("parseLinearTrigger returns created for artificial root comment create", () => {
  const trigger = parseLinearTrigger({
    type: "Comment",
    action: "create",
    isArtificialAgentSessionRoot: true,
    linearDelivery: "delivery-1",
    comment: {
      id: "comment-1",
      body: "@openclaw привіт",
      agentSession: { id: "session-1" },
      issue: {
        id: "issue-1",
        identifier: "LUK-1",
        title: "Test issue",
        url: "https://linear.app/test/issue/LUK-1",
        team: { key: "LUK" },
        project: { key: "done-camp" },
      },
    },
  });

  assert.ok(trigger);
  assert.equal(trigger?.source, "comment");
  assert.equal(trigger?.action, "created");
  assert.equal(trigger?.sessionId, "session-1");
  assert.equal(trigger?.eventKey, "linear:session:session-1:created");
  assert.equal(trigger?.subjectType, "issue");
  assert.equal(trigger?.subjectLabel, "LUK-1 Test issue");
  assert.equal(trigger?.issueIdentifier, "LUK-1");
  assert.equal(trigger?.teamKey, "LUK");
  assert.equal(trigger?.projectKey, "done-camp");
});

test("parseLinearTrigger prefers activity id for prompted event keys", () => {
  const trigger = parseLinearTrigger({
    type: "AgentSessionEvent",
    action: "prompted",
    linearDelivery: "delivery-2",
    agentSession: {
      id: "session-2",
      issue: { id: "issue-2", identifier: "LUK-2", title: "Bug" },
    },
    agentActivity: {
      id: "activity-9",
      body: "please debug this",
      agentSessionId: "session-2",
    },
  });

  assert.ok(trigger);
  assert.equal(trigger?.action, "prompted");
  assert.equal(trigger?.eventKey, "linear:activity:activity-9");
  assert.equal(trigger?.prompt, "please debug this");
});

test("parseLinearTrigger reads top-level prompt when activity body is absent", () => {
  const trigger = parseLinearTrigger({
    type: "AgentSessionEvent",
    action: "prompted",
    linearDelivery: "delivery-3",
    prompt: "why is prompt missing?",
    agentSession: {
      id: "session-3",
      issue: { id: "issue-3", identifier: "LUK-3", title: "Prompt bug" },
    },
    agentActivity: {
      id: "activity-10",
      agentSessionId: "session-3",
    },
  });

  assert.ok(trigger);
  assert.equal(trigger?.prompt, "why is prompt missing?");
  assert.equal(trigger?.eventKey, "linear:activity:activity-10");
});

test("parseLinearTrigger falls back to comment id for prompted comment events", () => {
  const trigger = parseLinearTrigger({
    type: "Comment",
    action: "update",
    comment: {
      id: "comment-7",
      body: "можеш глянути?",
      agentSession: { id: "session-7" },
    },
  });

  assert.ok(trigger);
  assert.equal(trigger?.action, "prompted");
  assert.equal(trigger?.eventKey, "linear:comment:comment-7");
});

test("parseLinearTrigger parses project comment context without issue fields", () => {
  const trigger = parseLinearTrigger({
    type: "Comment",
    action: "create",
    comment: {
      id: "comment-project-1",
      body: "@openclaw can you help?",
      agentSession: { id: "session-project-1" },
      project: {
        id: "project-1",
        key: "bridge",
        name: "linear-agent-bridge + linear-proxy",
        url: "https://linear.app/test/project/bridge",
      },
    },
  });

  assert.ok(trigger);
  assert.equal(trigger?.subjectType, "project");
  assert.equal(trigger?.subjectLabel, "linear-agent-bridge + linear-proxy");
  assert.equal(trigger?.projectId, "project-1");
  assert.equal(trigger?.projectKey, "bridge");
  assert.equal(trigger?.issueId, "");
});

test("parseLinearTrigger returns null when no session can be resolved", () => {
  const trigger = parseLinearTrigger({
    type: "Comment",
    action: "create",
    comment: { id: "comment-x", body: "@openclaw" },
  });

  assert.equal(trigger, null);
});
