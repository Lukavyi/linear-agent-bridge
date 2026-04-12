import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import {
  buildPromptedDuplicateKey,
  isBootstrapCommentCandidate,
  resetPromptedDuplicateState,
  shouldAllowSelfAuthoredBootstrap,
  shouldSkipPromptedDuplicate,
} from "./handler.js";

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
      {
        source: "comment",
        action: "prompted",
        sessionId: "sess",
        kind: "Comment",
        eventKey: "key",
        webhookId: "",
        deliveryId: "",
        signal: "",
        prompt: "@openclaw привіт",
        promptContext: "",
        guidance: "",
        issueId: "issue",
        issueIdentifier: "LUK-770",
        issueTitle: "Feature",
        issueDescription: "",
        issueUrl: "",
        teamKey: "",
        projectKey: "",
        commentId: "comment",
        activityId: "",
      },
    ),
    true,
  );
});

test("does not treat replies or artificial roots as bootstrap comment candidates", () => {
  const trigger = {
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
    issueId: "issue",
    issueIdentifier: "LUK-770",
    issueTitle: "Feature",
    issueDescription: "",
    issueUrl: "",
    teamKey: "",
    projectKey: "",
    commentId: "comment",
    activityId: "",
  };

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

function makePromptedTrigger(source: "agent-session" | "comment") {
  return {
    source,
    action: "prompted" as const,
    sessionId: "sess",
    kind: source === "comment" ? "Comment" : "AgentSessionEvent",
    eventKey: source === "comment" ? "linear:comment:c1" : "linear:activity:a1",
    webhookId: "",
    deliveryId: "",
    signal: "",
    prompt: "2+3?",
    promptContext: "",
    guidance: "",
    issueId: "issue",
    issueIdentifier: "LUK-770",
    issueTitle: "Feature",
    issueDescription: "",
    issueUrl: "",
    teamKey: "",
    projectKey: "",
    commentId: source === "comment" ? "comment-1" : "",
    activityId: source === "agent-session" ? "activity-1" : "",
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

test("skips prompted comment duplicate when agent-session event already arrived", async () => {
  resetPromptedDuplicateState();
  const sessionTrigger = makePromptedTrigger("agent-session");
  const commentTrigger = makePromptedTrigger("comment");
  const duplicateKey = buildPromptedDuplicateKey(sessionTrigger);

  assert.equal(
    await shouldSkipPromptedDuplicate(sessionTrigger, duplicateKey),
    false,
  );
  assert.equal(
    await shouldSkipPromptedDuplicate(commentTrigger, duplicateKey),
    true,
  );
});

test("skips prompted comment duplicate when agent-session event arrives during debounce", async () => {
  resetPromptedDuplicateState();
  const sessionTrigger = makePromptedTrigger("agent-session");
  const commentTrigger = makePromptedTrigger("comment");
  const duplicateKey = buildPromptedDuplicateKey(sessionTrigger);

  const pendingComment = shouldSkipPromptedDuplicate(commentTrigger, duplicateKey);
  await delay(25);
  assert.equal(
    await shouldSkipPromptedDuplicate(sessionTrigger, duplicateKey),
    false,
  );
  assert.equal(await pendingComment, true);
});

test("skips prompted comment duplicate for same session even when keys differ", async () => {
  resetPromptedDuplicateState();
  const sessionTrigger = makePromptedTrigger("agent-session");
  const commentTrigger = makePromptedTrigger("comment");
  commentTrigger.prompt = "same turn rendered differently";
  commentTrigger.promptContext = "with screenshot and history noise";

  assert.equal(
    await shouldSkipPromptedDuplicate(
      sessionTrigger,
      buildPromptedDuplicateKey(sessionTrigger),
    ),
    false,
  );
  assert.equal(
    await shouldSkipPromptedDuplicate(
      commentTrigger,
      buildPromptedDuplicateKey(commentTrigger),
    ),
    true,
  );
});
