import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPromptedDuplicateKey,
  hydrateTriggerPromptFromCommentHint,
  isBootstrapCommentCandidate,
  recoverTriggerFromReconcilePlan,
  rememberCommentPromptHint,
  resetCommentPromptHintState,
  resetPromptedDuplicateState,
  shouldAllowSelfAuthoredBootstrap,
  shouldIgnoreNativeCommentTrigger,
  shouldSkipPromptedDuplicate,
} from "./handler.js";

function makeIssueTrigger(overrides: Record<string, unknown> = {}) {
  return {
    source: "comment" as const,
    action: "prompted" as const,
    sessionId: "sess",
    kind: "Comment",
    eventKey: "key",
    webhookId: "",
    deliveryId: "",
    signal: "",
    prompt: "hi",
    promptContext: "",
    guidance: "",
    subjectType: "issue" as const,
    subjectId: "issue",
    subjectLabel: "LUK-770 Feature",
    subjectUrl: "",
    issueId: "issue",
    issueIdentifier: "LUK-770",
    issueTitle: "Feature",
    issueDescription: "",
    issueUrl: "",
    projectId: "",
    projectName: "",
    teamKey: "",
    projectKey: "",
    commentId: "comment",
    activityId: "",
    ...overrides,
  };
}

test("allows artificial root bootstrap comments through self-authored guard", () => {
  assert.equal(
    shouldAllowSelfAuthoredBootstrap({
      type: "Comment",
      action: "create",
      isArtificialAgentSessionRoot: true,
    }),
    true,
  );
});

test("does not allow normal visible self-authored comments through bootstrap guard", () => {
  assert.equal(
    shouldAllowSelfAuthoredBootstrap({
      type: "Comment",
      action: "create",
      isArtificialAgentSessionRoot: false,
    }),
    false,
  );

  assert.equal(
    shouldAllowSelfAuthoredBootstrap({
      type: "Comment",
      action: "update",
      isArtificialAgentSessionRoot: true,
    }),
    false,
  );
});

test("treats top-level prompted comment creates as bootstrap candidates", () => {
  assert.equal(
    isBootstrapCommentCandidate(
      {
        type: "Comment",
        action: "create",
        comment: { parentId: null },
      },
      makeIssueTrigger({ prompt: "@openclaw привіт" }),
    ),
    true,
  );
});

test("does not treat replies or artificial roots as bootstrap comment candidates", () => {
  const trigger = makeIssueTrigger();

  assert.equal(
    isBootstrapCommentCandidate(
      {
        type: "Comment",
        action: "create",
        comment: { parentId: "parent-1" },
      },
      trigger,
    ),
    false,
  );

  assert.equal(
    isBootstrapCommentCandidate(
      {
        type: "Comment",
        action: "create",
        isArtificialAgentSessionRoot: true,
        comment: { parentId: null },
      },
      trigger,
    ),
    false,
  );
});

test("ignores normal native-session comment triggers but keeps artificial bootstrap comments", () => {
  const trigger = makeIssueTrigger();

  assert.equal(
    shouldIgnoreNativeCommentTrigger(
      { type: "Comment", action: "create" },
      trigger,
    ),
    true,
  );

  assert.equal(
    shouldIgnoreNativeCommentTrigger(
      {
        type: "Comment",
        action: "create",
        isArtificialAgentSessionRoot: true,
      },
      trigger,
    ),
    false,
  );

  assert.equal(
    shouldIgnoreNativeCommentTrigger(
      {
        type: "Comment",
        action: "create",
        fallbackAgentSessionBootstrap: true,
      },
      trigger,
    ),
    false,
  );
});

function makePromptedTrigger(source: "agent-session" | "comment") {
  return {
    ...makeIssueTrigger({
      source,
      kind: source === "comment" ? "Comment" : "AgentSessionEvent",
      eventKey: source === "comment" ? "linear:comment:c1" : "linear:activity:a1",
      commentId: source === "comment" ? "comment-1" : "",
      activityId: source === "agent-session" ? "activity-1" : "",
      prompt: "2+3?",
    }),
  };
}

test("prompted duplicate key matches for equivalent session and prompt", () => {
  const sessionTrigger = makePromptedTrigger("agent-session");
  const commentTrigger = makePromptedTrigger("comment");
  commentTrigger.promptContext = "same turn but different context";

  assert.equal(
    buildPromptedDuplicateKey(sessionTrigger),
    buildPromptedDuplicateKey(commentTrigger),
  );
});

test("skips repeated prompted events with the same duplicate key", () => {
  resetPromptedDuplicateState();
  const sessionTrigger = makePromptedTrigger("agent-session");
  const duplicateKey = buildPromptedDuplicateKey(sessionTrigger);

  assert.equal(
    shouldSkipPromptedDuplicate(sessionTrigger, duplicateKey),
    false,
  );
  assert.equal(
    shouldSkipPromptedDuplicate(sessionTrigger, duplicateKey),
    true,
  );
});

test("hydrates missing agent-session prompt from a recent ignored comment webhook", async () => {
  resetCommentPromptHintState();

  rememberCommentPromptHint(
    makeIssueTrigger({
      source: "comment",
      kind: "Comment",
      prompt: "@openclaw глянь цей комент",
      commentId: "comment-42",
      sessionId: "session-42",
    }),
    {
      type: "Comment",
      action: "create",
      comment: { id: "comment-42", body: "@openclaw глянь цей комент" },
    },
  );

  const hydrated = await hydrateTriggerPromptFromCommentHint(
    makeIssueTrigger({
      source: "agent-session",
      kind: "AgentSessionEvent",
      prompt: "",
      commentId: "",
      sessionId: "session-42",
    }),
    [0],
  );

  assert.equal(hydrated.prompt, "@openclaw глянь цей комент");
  assert.equal(hydrated.commentId, "comment-42");
});

test("does not override an existing prompt when comment hint exists", async () => {
  resetCommentPromptHintState();

  rememberCommentPromptHint(
    makeIssueTrigger({
      source: "comment",
      kind: "Comment",
      prompt: "старий hint",
      commentId: "comment-43",
      sessionId: "session-43",
    }),
    {
      type: "Comment",
      action: "create",
      comment: { id: "comment-43", body: "старий hint" },
    },
  );

  const hydrated = await hydrateTriggerPromptFromCommentHint(
    makeIssueTrigger({
      source: "agent-session",
      kind: "AgentSessionEvent",
      prompt: "новий prompt",
      commentId: "",
      sessionId: "session-43",
    }),
    [0],
  );

  assert.equal(hydrated.prompt, "новий prompt");
  assert.equal(hydrated.commentId, "");
});

test("recoverTriggerFromReconcilePlan prefers latest unhandled prompt activity", () => {
  const trigger = makeIssueTrigger({
    source: "agent-session",
    kind: "AgentSessionEvent",
    action: "created",
    prompt: "",
    eventKey: "linear:session:sess:created",
    commentId: "",
  });

  const recovered = recoverTriggerFromReconcilePlan({
    trigger,
    snapshot: {
      sessionId: "sess",
      status: "active",
      issue: {
        id: "issue",
        identifier: "LUK-770",
        title: "Feature",
        description: "",
        url: "",
        teamKey: "LUK",
        projectKey: "bridge",
      },
      comment: { id: "comment-root", body: "root body", parentId: "" },
      sourceComment: { id: "comment-source", body: "source body", parentId: "" },
      activities: [],
    },
    plan: {
      promptTriggers: [
        {
          ...makeIssueTrigger({
            source: "agent-session",
            kind: "AgentSessionEvent",
            action: "prompted",
            prompt: "first prompt",
            eventKey: "linear:activity:a1",
            activityId: "a1",
            commentId: "comment-source",
          }),
        },
        {
          ...makeIssueTrigger({
            source: "agent-session",
            kind: "AgentSessionEvent",
            action: "prompted",
            prompt: "second prompt",
            eventKey: "linear:activity:a2",
            activityId: "a2",
            commentId: "comment-source",
          }),
        },
      ],
    },
  });

  assert.equal(recovered.eventKey, "linear:activity:a2");
  assert.equal(recovered.prompt, "second prompt");
});

test("recoverTriggerFromReconcilePlan falls back to source comment body for created turn", () => {
  const trigger = makeIssueTrigger({
    source: "agent-session",
    kind: "AgentSessionEvent",
    action: "created",
    prompt: "",
    eventKey: "linear:session:sess:created",
    commentId: "",
  });

  const recovered = recoverTriggerFromReconcilePlan({
    trigger,
    snapshot: {
      sessionId: "sess",
      status: "active",
      issue: {
        id: "issue",
        identifier: "LUK-770",
        title: "Feature",
        description: "",
        url: "",
        teamKey: "LUK",
        projectKey: "bridge",
      },
      comment: { id: "comment-root", body: "", parentId: "" },
      sourceComment: { id: "comment-source", body: "first user message", parentId: "" },
      activities: [],
    },
    plan: {
      promptTriggers: [],
    },
  });

  assert.equal(recovered.prompt, "first user message");
  assert.equal(recovered.commentId, "comment-source");
});
