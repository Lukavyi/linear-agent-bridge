import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReconcilePlan,
  findUnhandledPromptActivities,
  type SessionActivityInfo,
  type SessionReconcileSnapshot,
} from "./reconcile.js";

function makeActivity(input: Partial<SessionActivityInfo>): SessionActivityInfo {
  return {
    id: input.id ?? "a1",
    type: input.type ?? "prompt",
    text: input.text ?? "hi",
    createdAt: input.createdAt ?? "2026-04-14T10:00:00.000Z",
    updatedAt: input.updatedAt ?? input.createdAt ?? "2026-04-14T10:00:00.000Z",
  };
}

function makeSnapshot(activities: SessionActivityInfo[]): SessionReconcileSnapshot {
  return {
    sessionId: "sess-1",
    status: "pending",
    issue: {
      id: "issue-1",
      identifier: "LUK-999",
      title: "Test",
      description: "Desc",
      url: "https://linear.app/lukavyi/issue/LUK-999/test",
      teamKey: "team-1",
      projectKey: "project-1",
    },
    comment: {
      id: "comment-1",
      body: "Please help",
      parentId: "",
    },
    sourceComment: {
      id: "",
      body: "",
      parentId: "",
    },
    activities,
  };
}

test("finds only trailing prompts without later agent activity", () => {
  const activities = [
    makeActivity({ id: "p1", type: "prompt", text: "first" }),
    makeActivity({
      id: "r1",
      type: "response",
      text: "done",
      createdAt: "2026-04-14T10:01:00.000Z",
    }),
    makeActivity({
      id: "p2",
      type: "prompt",
      text: "second",
      createdAt: "2026-04-14T10:02:00.000Z",
    }),
  ];

  assert.deepEqual(
    findUnhandledPromptActivities(activities).map((entry) => entry.id),
    ["p2"],
  );
});

test("manual reconcile schedules missing created event for untouched session", () => {
  const plan = buildReconcilePlan({
    snapshot: makeSnapshot([]),
    isEventProcessed: () => false,
  });

  assert.equal(plan.createdTrigger?.eventKey, "linear:session:sess-1:created");
  assert.equal(plan.promptTriggers.length, 0);
  assert.match(plan.createdTrigger?.promptContext ?? "", /<issue identifier="LUK-999">/);
});

test("manual reconcile skips prompts already followed by agent output", () => {
  const plan = buildReconcilePlan({
    snapshot: makeSnapshot([
      makeActivity({ id: "p1", type: "prompt", text: "first" }),
      makeActivity({
        id: "t1",
        type: "thought",
        text: "thinking",
        createdAt: "2026-04-14T10:01:00.000Z",
      }),
      makeActivity({
        id: "p2",
        type: "prompt",
        text: "second",
        createdAt: "2026-04-14T10:02:00.000Z",
      }),
    ]),
    isEventProcessed: () => false,
  });

  assert.equal(plan.createdTrigger, undefined);
  assert.deepEqual(plan.promptTriggers.map((entry) => entry.activityId), ["p2"]);
});

test("manual reconcile filters out durably processed prompt activities", () => {
  const plan = buildReconcilePlan({
    snapshot: makeSnapshot([
      makeActivity({ id: "p1", type: "prompt", text: "first" }),
    ]),
    isEventProcessed: (eventKey) => eventKey === "linear:activity:p1",
  });

  assert.equal(plan.createdTrigger, undefined);
  assert.deepEqual(plan.promptTriggers, []);
});
