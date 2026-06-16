import test from "node:test";
import assert from "node:assert/strict";

import {
  validateWrite,
  isInSubtree,
  isTriggerHonored,
  isAgentId,
  isAction,
  ASSIGN_CODER_TRIGGER_LABELS,
  type AgentId,
  type Action,
  type IssueTree,
  type WriteRequest,
  type DecisionLog,
} from "./capability-matrix.js";

// A small tree used across scope tests:
//   root
//    └─ a
//        └─ b
//            └─ c
//   other (separate subtree)
const TREE: IssueTree = {
  root: null,
  a: "root",
  b: "a",
  c: "b",
  other: null,
  otherChild: "other",
};

const ALL_AGENTS: AgentId[] = ["inbox", "mailman", "researcher", "developer"];

function base(overrides: Partial<WriteRequest>): WriteRequest {
  return {
    agent: "inbox",
    action: "comment",
    origin: "root",
    tree: TREE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// type guards
// ---------------------------------------------------------------------------

test("isAgentId accepts the four known agents and rejects anything else", () => {
  for (const a of ALL_AGENTS) assert.equal(isAgentId(a), true);
  assert.equal(isAgentId("operator"), false);
  assert.equal(isAgentId("INBOX"), false);
  assert.equal(isAgentId(""), false);
  assert.equal(isAgentId(undefined), false);
  assert.equal(isAgentId(42), false);
});

test("isAction accepts only the allowlisted actions", () => {
  for (const a of [
    "search_issues",
    "create_issue",
    "comment",
    "set_label",
    "update_state",
  ] satisfies Action[]) {
    assert.equal(isAction(a), true);
  }
  for (const bad of ["raw_graphql", "run_command", "shell", "delete_issue", ""]) {
    assert.equal(isAction(bad), false);
  }
});

// ---------------------------------------------------------------------------
// Step 1 — unknown agent
// ---------------------------------------------------------------------------

test("unknown agent is denied regardless of action", () => {
  const r = validateWrite(
    base({ agent: "operator" as unknown as AgentId, action: "comment" }),
  );
  assert.equal(r.allowed, false);
  assert.equal(r.decision, "deny");
  assert.equal(r.log.agent, null);
  assert.match(r.reason, /unknown agent/);
});

// ---------------------------------------------------------------------------
// Step 2 — action allowlist (incl. explicit raw_graphql rejection)
// ---------------------------------------------------------------------------

test("raw_graphql is rejected regardless of params, for every agent", () => {
  for (const agent of ALL_AGENTS) {
    const r = validateWrite(
      base({
        agent,
        action: "raw_graphql",
        target: "root",
        // even with otherwise-valid scope, a forbidden action is rejected
      }),
    );
    assert.equal(r.allowed, false, `${agent} should not run raw_graphql`);
    assert.match(r.reason, /action not allowed/);
    assert.equal(r.log.action, null);
  }
});

test("other forbidden free-form actions are rejected", () => {
  for (const action of ["run_command", "shell", "exec", "delete_issue"]) {
    const r = validateWrite(base({ action, target: "root" }));
    assert.equal(r.allowed, false, `${action} should be rejected`);
    assert.match(r.reason, /action not allowed/);
  }
});

// ---------------------------------------------------------------------------
// Step 3 — capability matrix, cell by cell (allow + deny)
// ---------------------------------------------------------------------------

// search_issues: inbox only
test("matrix: search_issues — inbox allowed, others denied", () => {
  for (const agent of ALL_AGENTS) {
    const r = validateWrite(base({ agent, action: "search_issues" }));
    if (agent === "inbox") {
      assert.equal(r.allowed, true, "inbox can search");
      assert.equal(r.log.target, null, "search has no single target");
    } else {
      assert.equal(r.allowed, false, `${agent} cannot search`);
      assert.match(r.reason, /search beyond/);
    }
  }
});

// create_issue: inbox + mailman
test("matrix: create_issue — inbox & mailman allowed, researcher & developer denied", () => {
  for (const agent of ALL_AGENTS) {
    const r = validateWrite(
      base({ agent, action: "create_issue", parent: "a", origin: "root" }),
    );
    if (agent === "inbox" || agent === "mailman") {
      assert.equal(r.allowed, true, `${agent} can create`);
    } else {
      assert.equal(r.allowed, false, `${agent} cannot create`);
      assert.match(r.reason, /may not create/);
    }
  }
});

// comment in own session's issue: ALL agents
test("matrix: comment in own subtree — allowed for every agent", () => {
  for (const agent of ALL_AGENTS) {
    const r = validateWrite(
      base({ agent, action: "comment", target: "b", origin: "root" }),
    );
    assert.equal(r.allowed, true, `${agent} can comment in own subtree`);
    assert.match(r.reason, /own subtree/);
  }
});

// comment in another issue: inbox only
test("matrix: comment in another issue — inbox allowed, others denied", () => {
  for (const agent of ALL_AGENTS) {
    const r = validateWrite(
      base({ agent, action: "comment", target: "other", origin: "root" }),
    );
    if (agent === "inbox") {
      assert.equal(r.allowed, true, "inbox can append to a duplicate");
      assert.match(r.reason, /another issue/);
    } else {
      assert.equal(r.allowed, false, `${agent} cannot comment outside subtree`);
      assert.match(r.reason, /own session subtree/);
    }
  }
});

// set_label (triage): inbox only
test("matrix: set_label triage — inbox allowed, others denied", () => {
  for (const agent of ALL_AGENTS) {
    const r = validateWrite(
      base({
        agent,
        action: "set_label",
        target: "a",
        origin: "root",
        labels: ["needs-triage"],
      }),
    );
    if (agent === "inbox") {
      assert.equal(r.allowed, true, "inbox can set triage labels");
    } else {
      assert.equal(r.allowed, false, `${agent} cannot set labels`);
      assert.match(r.reason, /may not set labels/);
    }
  }
});

// update_state: NOBODY
test("matrix: update_state — denied for every agent", () => {
  for (const agent of ALL_AGENTS) {
    const r = validateWrite(
      base({ agent, action: "update_state", target: "a", origin: "root" }),
    );
    assert.equal(r.allowed, false, `${agent} cannot update state`);
    assert.match(r.reason, /update issue state/);
  }
});

// ---------------------------------------------------------------------------
// The assign-coder / ready-for-agent gate — settable by NO agent, ever
// ---------------------------------------------------------------------------

test("ready-for-agent and assign-coder labels are settable by no agent, ever", () => {
  for (const agent of ALL_AGENTS) {
    for (const label of [...ASSIGN_CODER_TRIGGER_LABELS]) {
      const r = validateWrite(
        base({
          agent,
          action: "set_label",
          target: "a",
          origin: "root",
          labels: [label],
        }),
      );
      assert.equal(r.allowed, false, `${agent} must not set "${label}"`);
      assert.match(r.reason, /operator trust gate/);
    }
  }
});

test("the gate is matched case-insensitively and even mixed with valid labels", () => {
  const r = validateWrite(
    base({
      agent: "inbox",
      action: "set_label",
      target: "a",
      origin: "root",
      labels: ["needs-triage", "Ready-For-Agent"],
    }),
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason, /operator trust gate/);
});

test("the gate is checked before the capability bit (mailman + gate label still denies on the gate)", () => {
  const r = validateWrite(
    base({
      agent: "mailman",
      action: "set_label",
      target: "a",
      origin: "root",
      labels: ["ready-for-agent"],
    }),
  );
  assert.equal(r.allowed, false);
  // The reason must be the gate, not the (also-true) "may not set labels".
  assert.match(r.reason, /operator trust gate/);
});

// ---------------------------------------------------------------------------
// Step 4 — subtree-scope predicate (unit + via validateWrite)
// ---------------------------------------------------------------------------

test("isInSubtree: target == origin", () => {
  assert.equal(isInSubtree("root", "root", TREE), true);
  assert.equal(isInSubtree("a", "a", TREE), true);
});

test("isInSubtree: multi-level ancestor chain", () => {
  assert.equal(isInSubtree("a", "root", TREE), true);
  assert.equal(isInSubtree("b", "root", TREE), true);
  assert.equal(isInSubtree("c", "root", TREE), true);
  assert.equal(isInSubtree("c", "a", TREE), true);
  assert.equal(isInSubtree("c", "b", TREE), true);
});

test("isInSubtree: out-of-subtree is rejected", () => {
  assert.equal(isInSubtree("other", "root", TREE), false);
  assert.equal(isInSubtree("otherChild", "root", TREE), false);
  // ancestor direction must not count: root is not inside a's subtree
  assert.equal(isInSubtree("root", "a", TREE), false);
  assert.equal(isInSubtree("b", "c", TREE), false);
});

test("isInSubtree: relations are excluded — only parentId chain is walked", () => {
  // A tree where `target` is related/blocked-by `origin` but NOT a descendant.
  // We model that simply: there is no parentId path, so it is out of scope.
  const tree: IssueTree = { dup: null, origin: null };
  assert.equal(isInSubtree("dup", "origin", tree), false);
});

test("isInSubtree: missing / empty inputs deny by default", () => {
  assert.equal(isInSubtree("", "root", TREE), false);
  assert.equal(isInSubtree("a", "", TREE), false);
  assert.equal(isInSubtree("unknown", "root", TREE), false);
});

test("isInSubtree: cycle in the tree does not loop forever (denies)", () => {
  const cyclic: IssueTree = { x: "y", y: "z", z: "x" };
  assert.equal(isInSubtree("x", "root", cyclic), false);
});

test("isInSubtree: deep chain still resolves", () => {
  const deep: IssueTree = {};
  let prev: string | null = null;
  for (let i = 0; i <= 50; i++) {
    (deep as Record<string, string | null>)[`n${i}`] = prev;
    prev = `n${i}`;
  }
  assert.equal(isInSubtree("n50", "n0", deep), true);
  assert.equal(isInSubtree("n50", "n49", deep), true);
});

test("comment outside subtree is denied for a non-inbox agent (scope enforced)", () => {
  const r = validateWrite(
    base({ agent: "researcher", action: "comment", target: "other", origin: "root" }),
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason, /own session subtree/);
});

test("set_label outside subtree is denied even for inbox", () => {
  const r = validateWrite(
    base({
      agent: "inbox",
      action: "set_label",
      target: "other",
      origin: "root",
      labels: ["needs-triage"],
    }),
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason, /outside the session subtree/);
});

// create_issue parent-in-subtree
test("create_issue: parent inside subtree is allowed", () => {
  const r = validateWrite(
    base({ agent: "mailman", action: "create_issue", parent: "b", origin: "root" }),
  );
  assert.equal(r.allowed, true);
  assert.equal(r.log.target, "b");
});

test("create_issue: parent == origin is allowed", () => {
  const r = validateWrite(
    base({ agent: "inbox", action: "create_issue", parent: "root", origin: "root" }),
  );
  assert.equal(r.allowed, true);
});

test("create_issue: parent outside subtree is denied", () => {
  const r = validateWrite(
    base({ agent: "inbox", action: "create_issue", parent: "other", origin: "root" }),
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason, /outside the session subtree/);
});

test("create_issue: a parentless (root) create is denied — it would escape the subtree", () => {
  const r = validateWrite(
    base({ agent: "inbox", action: "create_issue", parent: null, origin: "root" }),
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason, /must have a parent/);
});

test("search_issues is NOT subtree-scoped — allowed for inbox even with no origin/tree", () => {
  const r = validateWrite({ agent: "inbox", action: "search_issues" });
  assert.equal(r.allowed, true);
  assert.match(r.reason, /not subtree-scoped/);
});

// ---------------------------------------------------------------------------
// missing-data deny-by-default paths
// ---------------------------------------------------------------------------

test("comment with missing target is denied", () => {
  const r = validateWrite(base({ agent: "inbox", action: "comment", target: undefined }));
  assert.equal(r.allowed, false);
  assert.match(r.reason, /missing comment target/);
});

test("comment with missing origin is denied", () => {
  const r = validateWrite(
    base({ agent: "inbox", action: "comment", target: "a", origin: undefined }),
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason, /missing session origin/);
});

test("create_issue with missing origin is denied", () => {
  const r = validateWrite(
    base({ agent: "inbox", action: "create_issue", parent: "a", origin: undefined }),
  );
  assert.equal(r.allowed, false);
  assert.match(r.reason, /missing session origin/);
});

// ---------------------------------------------------------------------------
// Step 5 — actor-gate
// ---------------------------------------------------------------------------

const OPERATOR = "operator-user-id";
const AGENT_USER_IDS = {
  inbox: "inbox-uid",
  mailman: "mailman-uid",
  researcher: "researcher-uid",
  developer: "developer-uid",
} as const;

test("actor-gate: operator-originated trigger is honored", () => {
  assert.equal(
    isTriggerHonored({
      operatorUserId: OPERATOR,
      actorUserId: OPERATOR,
      targetAgent: "inbox",
      agentUserIds: AGENT_USER_IDS,
    }),
    true,
  );
});

test("actor-gate: agent-originated triggers are ignored (except mailman→researcher)", () => {
  // inbox firing inbox — ignored
  assert.equal(
    isTriggerHonored({
      operatorUserId: OPERATOR,
      actorUserId: AGENT_USER_IDS.inbox,
      targetAgent: "developer",
      agentUserIds: AGENT_USER_IDS,
    }),
    false,
  );
  // developer firing researcher — ignored
  assert.equal(
    isTriggerHonored({
      operatorUserId: OPERATOR,
      actorUserId: AGENT_USER_IDS.developer,
      targetAgent: "researcher",
      agentUserIds: AGENT_USER_IDS,
    }),
    false,
  );
});

test("actor-gate: the documented mailman→researcher exception is honored", () => {
  assert.equal(
    isTriggerHonored({
      operatorUserId: OPERATOR,
      actorUserId: AGENT_USER_IDS.mailman,
      targetAgent: "researcher",
      agentUserIds: AGENT_USER_IDS,
    }),
    true,
  );
});

test("actor-gate: mailman may NOT trigger anything other than researcher", () => {
  for (const targetAgent of ["inbox", "mailman", "developer"] as AgentId[]) {
    assert.equal(
      isTriggerHonored({
        operatorUserId: OPERATOR,
        actorUserId: AGENT_USER_IDS.mailman,
        targetAgent,
        agentUserIds: AGENT_USER_IDS,
      }),
      false,
      `mailman must not trigger ${targetAgent}`,
    );
  }
});

test("actor-gate: missing operator or actor id denies", () => {
  assert.equal(
    isTriggerHonored({ operatorUserId: "", actorUserId: OPERATOR }),
    false,
  );
  assert.equal(
    isTriggerHonored({ operatorUserId: OPERATOR, actorUserId: "" }),
    false,
  );
});

test("actor-gate: an unknown actor (not operator, not mailman) is ignored", () => {
  assert.equal(
    isTriggerHonored({
      operatorUserId: OPERATOR,
      actorUserId: "some-random-uid",
      targetAgent: "researcher",
      agentUserIds: AGENT_USER_IDS,
    }),
    false,
  );
});

test("actor-gate: mailman→researcher needs the mailman uid to be known", () => {
  // No agentUserIds map → cannot recognize mailman → ignored.
  assert.equal(
    isTriggerHonored({
      operatorUserId: OPERATOR,
      actorUserId: AGENT_USER_IDS.mailman,
      targetAgent: "researcher",
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Step 6 — logging
// ---------------------------------------------------------------------------

test("every decision produces a structured log record (allow)", () => {
  const r = validateWrite(
    base({ agent: "inbox", action: "comment", target: "b", origin: "root" }),
  );
  assert.deepEqual(r.log, {
    agent: "inbox",
    action: "comment",
    target: "b",
    decision: "allow",
    reason: r.reason,
  } satisfies DecisionLog);
});

test("every decision produces a structured log record (deny)", () => {
  const r = validateWrite(
    base({ agent: "developer", action: "update_state", target: "a", origin: "root" }),
  );
  assert.equal(r.log.agent, "developer");
  assert.equal(r.log.action, "update_state");
  assert.equal(r.log.target, "a");
  assert.equal(r.log.decision, "deny");
  assert.ok(r.log.reason.length > 0);
});

test("the optional logger hook receives the same record (no I/O performed here)", () => {
  const records: DecisionLog[] = [];
  const r = validateWrite(
    base({ agent: "inbox", action: "search_issues" }),
    (log) => records.push(log),
  );
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], r.log);
});

test("the logger fires on denials too", () => {
  const records: DecisionLog[] = [];
  validateWrite(base({ action: "raw_graphql", target: "root" }), (log) =>
    records.push(log),
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, "deny");
});
