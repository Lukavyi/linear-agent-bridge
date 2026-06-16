/**
 * FLOW-171 — Bridge capability matrix + actor-gate + subtree-scope validator.
 *
 * Linear-side policy enforcement as PURE functions. There is NO network or I/O
 * here: the caller supplies all data (the authenticated agent, the requested
 * action and its params, the issue tree, the operator/actor ids). Agents hold
 * ZERO Linear token — the bridge is the only thing that talks to Linear, and it
 * validates every write through {@link validateWrite} before performing it.
 *
 * The validator enforces, in order:
 *   1. Per-agent token auth (the caller resolves the token to one {@link AgentId}).
 *   2. Action ∈ enum allowlist (unknown actions, incl. `raw_graphql`, REJECT).
 *   3. Capability-matrix row for that agent.
 *   4. Object-scope (subtree-scope predicate) — write target must be inside the
 *      session's subtree (target == origin or origin is an ancestor of target).
 *   5. Actor-gate — a session/label trigger is honored only if it came from the
 *      operator, with one documented exception: `mailman → researcher`.
 *   6. Logging — every decision yields a structured {@link DecisionLog} record.
 *
 * Security posture: deny by default. Any shape we do not explicitly understand
 * (unknown agent, unknown action, missing scope data, missing actor) is denied.
 */

/** The four bridge agents, in descending order of trust / rights. */
export type AgentId = "inbox" | "mailman" | "researcher" | "developer";

const AGENT_IDS = new Set<AgentId>([
  "inbox",
  "mailman",
  "researcher",
  "developer",
]);

/**
 * The ONLY actions the bridge knows how to perform. Anything outside this set —
 * notably `raw_graphql`, `run_command`, `shell`, free-form GraphQL of any kind —
 * is rejected before the capability matrix is even consulted. There is no
 * raw-GraphQL escape hatch, ever.
 */
export type Action =
  | "search_issues"
  | "create_issue"
  | "comment"
  | "set_label"
  | "update_state";

const ACTIONS = new Set<Action>([
  "search_issues",
  "create_issue",
  "comment",
  "set_label",
  "update_state",
]);

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && AGENT_IDS.has(value as AgentId);
}

export function isAction(value: unknown): value is Action {
  return typeof value === "string" && ACTIONS.has(value as Action);
}

/**
 * Trigger labels that elevate trust — `ready-for-agent` and the "assign the
 * coder agent" labels. These are settable by NO agent, EVER: they are the
 * operator's manual trust-elevation gate, applied by a human in Linear. If a
 * `set_label` request names any label in this set, it is denied regardless of
 * which agent asked.
 *
 * Matching is case-insensitive (Linear label names are display strings).
 */
export const ASSIGN_CODER_TRIGGER_LABELS: ReadonlySet<string> = new Set([
  "ready-for-agent",
  "assign-coder",
  "assign-developer",
]);

function isAssignCoderLabel(label: string): boolean {
  return ASSIGN_CODER_TRIGGER_LABELS.has(label.trim().toLowerCase());
}

/**
 * The issue tree the caller supplies: a map of issueId → parentId. A root issue
 * either maps to `null`/`undefined` or is absent from the map. Only the
 * parent/sub-issue tree is modeled here — Linear relations (blocks / related /
 * duplicate) are deliberately NOT part of scope.
 */
export type IssueTree = Readonly<Record<string, string | null | undefined>>;

/**
 * Capabilities granted to one agent. `commentInOwnIssue` is granted to every
 * agent (each can comment in its own session's issue); the rest are narrower.
 * `searchBeyondSession` is the one capability that is intentionally NOT
 * subtree-scoped — it is workspace-wide by purpose and granted to inbox only.
 */
interface Capabilities {
  /** Workspace-wide read. NOT subtree-scoped. Inbox only. */
  searchBeyondSession: boolean;
  createIssue: boolean;
  /** Comment inside the agent's own session issue (the session origin subtree). */
  commentInOwnIssue: boolean;
  /** Comment in another issue (append to a found duplicate). Inbox only. */
  commentInOtherIssue: boolean;
  /** Apply triage labels (excluding the assign-coder gate, which nobody can). */
  setTriageLabel: boolean;
  /** Move issues between workflow states. Granted to nobody in v1. */
  updateState: boolean;
}

/**
 * Capability matrix (v1). `inbox` has the most rights (it sees no untrusted
 * input); `researcher` the least (its only write is a comment in its own
 * session issue). `update_state` is granted to nobody. The assign-coder gate is
 * enforced separately and is also granted to nobody.
 */
const CAPABILITY_MATRIX: Readonly<Record<AgentId, Capabilities>> = {
  inbox: {
    searchBeyondSession: true,
    createIssue: true,
    commentInOwnIssue: true,
    commentInOtherIssue: true,
    setTriageLabel: true,
    updateState: false,
  },
  mailman: {
    searchBeyondSession: false,
    createIssue: true,
    commentInOwnIssue: true,
    commentInOtherIssue: false,
    setTriageLabel: false,
    updateState: false,
  },
  researcher: {
    searchBeyondSession: false,
    createIssue: false,
    commentInOwnIssue: true,
    commentInOtherIssue: false,
    setTriageLabel: false,
    updateState: false,
  },
  developer: {
    searchBeyondSession: false,
    createIssue: false,
    commentInOwnIssue: true,
    commentInOtherIssue: false,
    setTriageLabel: false,
    updateState: false,
  },
};

export type Decision = "allow" | "deny";

/**
 * Structured log record produced for EVERY decision. The caller logs this
 * (no I/O is done here). `target` is the issue the write acts on, or `null`
 * for an action with no single concrete target (e.g. `search_issues`, or a
 * malformed request we reject before resolving a target).
 */
export interface DecisionLog {
  agent: AgentId | null;
  action: Action | null;
  target: string | null;
  decision: Decision;
  reason: string;
}

export interface ValidationResult {
  decision: Decision;
  /** True iff `decision === "allow"`. Convenience for callers. */
  allowed: boolean;
  reason: string;
  log: DecisionLog;
}

/** Optional hook so the caller can log each decision without doing I/O here. */
export type DecisionLogger = (log: DecisionLog) => void;

/**
 * A write request, fully described by the caller (the bridge), after it has
 * authenticated the agent token. The validator never reaches out for any of
 * this — it is all supplied.
 */
export interface WriteRequest {
  /** The agent resolved from the per-agent token (step 1, done by caller). */
  agent: AgentId;
  /** The requested action. May be any string — unknown ones are rejected. */
  action: Action | string;
  /**
   * The issue this write acts on. Required for `comment`, `set_label`,
   * `update_state`. For `create_issue` the relevant field is `parent` instead.
   * Ignored for `search_issues`.
   */
  target?: string;
  /** The session's origin issue — the root of the subtree this agent may write to. */
  origin?: string;
  /** The issue tree (issueId → parentId). Supplied by the caller; kept pure. */
  tree?: IssueTree;
  /** For `create_issue`: the parent the new issue would be filed under. */
  parent?: string | null;
  /** For `set_label`: the labels being applied. */
  labels?: readonly string[];
}

/** Inputs for the actor-gate (step 5). Used by {@link isTriggerHonored}. */
export interface TriggerContext {
  /** The operator's Linear user id (the human who owns the trust gate). */
  operatorUserId: string;
  /** The user/agent id that actually fired this trigger. */
  actorUserId: string;
  /** The agent the trigger is trying to activate (for the documented exception). */
  targetAgent?: AgentId;
  /** Map of agentId → its Linear user id, so we can recognize agent-originated triggers. */
  agentUserIds?: Readonly<Partial<Record<AgentId, string>>>;
}

const MAX_TREE_DEPTH = 1000;

/**
 * Subtree-scope predicate (step 4). A write on `target` is allowed iff
 * `target === origin` OR `origin` is an ancestor of `target` (walk `target`'s
 * parentId chain upward; if we reach `origin`, it is in scope).
 *
 * Pure: the tree is supplied. Relations are never consulted — only parentId.
 * Cycle-safe and depth-bounded so a malformed tree cannot loop forever; if a
 * cycle or absurd depth is hit before reaching `origin`, the answer is `false`
 * (deny by default).
 */
export function isInSubtree(
  target: string,
  origin: string,
  tree: IssueTree,
): boolean {
  if (!target || !origin) return false;
  if (target === origin) return true;

  const seen = new Set<string>();
  let current: string | null | undefined = tree[target];
  let depth = 0;
  while (current != null) {
    if (current === origin) return true;
    if (seen.has(current)) return false; // cycle → out of scope
    if (++depth > MAX_TREE_DEPTH) return false; // runaway → out of scope
    seen.add(current);
    current = tree[current];
  }
  return false;
}

function deny(
  agent: AgentId | null,
  action: Action | null,
  target: string | null,
  reason: string,
  logger?: DecisionLogger,
): ValidationResult {
  return finish(agent, action, target, "deny", reason, logger);
}

function allow(
  agent: AgentId,
  action: Action,
  target: string | null,
  reason: string,
  logger?: DecisionLogger,
): ValidationResult {
  return finish(agent, action, target, "allow", reason, logger);
}

function finish(
  agent: AgentId | null,
  action: Action | null,
  target: string | null,
  decision: Decision,
  reason: string,
  logger?: DecisionLogger,
): ValidationResult {
  const log: DecisionLog = { agent, action, target, decision, reason };
  logger?.(log);
  return { decision, allowed: decision === "allow", reason, log };
}

/**
 * Validate a single write request (steps 1–4 + logging). Step 1 (token → agent)
 * is the caller's job; the resolved agent is passed in. Step 5 (actor-gate) is a
 * separate concern with its own inputs — see {@link isTriggerHonored} — because a
 * trigger is honored *before* an agent ever issues a write.
 *
 * Returns a {@link ValidationResult} whose `.log` is the structured record. If a
 * `logger` is supplied it is also invoked with that record (no other I/O).
 */
export function validateWrite(
  req: WriteRequest,
  logger?: DecisionLogger,
): ValidationResult {
  const target = typeof req.target === "string" ? req.target : null;

  // Step 1 — the caller resolved a token to an agent; reject anything that is
  // not one of the four known agents (defense in depth).
  if (!isAgentId(req.agent)) {
    return deny(null, null, target, "unknown agent", logger);
  }
  const agent = req.agent;

  // Step 2 — action allowlist. Unknown actions (raw_graphql, run_command,
  // shell, free-form GraphQL, anything) are rejected before the matrix.
  if (!isAction(req.action)) {
    return deny(
      agent,
      null,
      target,
      `action not allowed: ${String(req.action)}`,
      logger,
    );
  }
  const action = req.action;
  const caps = CAPABILITY_MATRIX[agent];

  switch (action) {
    case "search_issues":
      return validateSearch(agent, caps, logger);
    case "create_issue":
      return validateCreateIssue(agent, caps, req, logger);
    case "comment":
      return validateComment(agent, caps, req, target, logger);
    case "set_label":
      return validateSetLabel(agent, caps, req, target, logger);
    case "update_state":
      return validateUpdateState(agent, caps, target, logger);
    default:
      // Unreachable given the allowlist above; deny by default if it ever isn't.
      return deny(agent, action, target, "unhandled action", logger);
  }
}

function validateSearch(
  agent: AgentId,
  caps: Capabilities,
  logger?: DecisionLogger,
): ValidationResult {
  // search_issues is the one capability deliberately NOT subtree-scoped: it is
  // workspace-wide by purpose, and granted to inbox only.
  if (!caps.searchBeyondSession) {
    return deny(
      agent,
      "search_issues",
      null,
      "agent may not search beyond its session",
      logger,
    );
  }
  return allow(
    agent,
    "search_issues",
    null,
    "search granted (workspace-wide, not subtree-scoped)",
    logger,
  );
}

function validateCreateIssue(
  agent: AgentId,
  caps: Capabilities,
  req: WriteRequest,
  logger?: DecisionLogger,
): ValidationResult {
  if (!caps.createIssue) {
    return deny(agent, "create_issue", null, "agent may not create issues", logger);
  }
  // The new issue's parent must be inside the session subtree (parent == origin
  // or a descendant of origin). A parentless create would escape the subtree, so
  // it is denied.
  const origin = req.origin;
  const parent = typeof req.parent === "string" ? req.parent : null;
  if (!origin) {
    return deny(agent, "create_issue", parent, "missing session origin", logger);
  }
  if (!parent) {
    return deny(
      agent,
      "create_issue",
      null,
      "new issue must have a parent inside the session subtree",
      logger,
    );
  }
  if (!isInSubtree(parent, origin, req.tree ?? {})) {
    return deny(
      agent,
      "create_issue",
      parent,
      "new issue parent is outside the session subtree",
      logger,
    );
  }
  return allow(agent, "create_issue", parent, "create within subtree", logger);
}

function validateComment(
  agent: AgentId,
  caps: Capabilities,
  req: WriteRequest,
  target: string | null,
  logger?: DecisionLogger,
): ValidationResult {
  if (!target) {
    return deny(agent, "comment", null, "missing comment target", logger);
  }
  if (!req.origin) {
    return deny(agent, "comment", target, "missing session origin", logger);
  }
  const inOwnSubtree = isInSubtree(target, req.origin, req.tree ?? {});
  if (inOwnSubtree) {
    // Every agent may comment inside its own session subtree.
    return allow(agent, "comment", target, "comment within own subtree", logger);
  }
  // Commenting in another issue (e.g. appending to a found duplicate) is an
  // inbox-only right.
  if (caps.commentInOtherIssue) {
    return allow(
      agent,
      "comment",
      target,
      "comment in another issue (append to duplicate)",
      logger,
    );
  }
  return deny(
    agent,
    "comment",
    target,
    "agent may only comment inside its own session subtree",
    logger,
  );
}

function validateSetLabel(
  agent: AgentId,
  caps: Capabilities,
  req: WriteRequest,
  target: string | null,
  logger?: DecisionLogger,
): ValidationResult {
  const labels = req.labels ?? [];
  // The assign-coder / ready-for-agent gate is settable by NO agent, ever —
  // checked first, ahead of the capability bit, so it cannot be bypassed.
  const gateLabel = labels.find((label) => isAssignCoderLabel(label));
  if (gateLabel) {
    return deny(
      agent,
      "set_label",
      target,
      `label "${gateLabel}" is the operator trust gate; no agent may set it`,
      logger,
    );
  }
  if (!caps.setTriageLabel) {
    return deny(agent, "set_label", target, "agent may not set labels", logger);
  }
  if (!target) {
    return deny(agent, "set_label", null, "missing label target", logger);
  }
  if (!req.origin) {
    return deny(agent, "set_label", target, "missing session origin", logger);
  }
  if (!isInSubtree(target, req.origin, req.tree ?? {})) {
    return deny(
      agent,
      "set_label",
      target,
      "label target is outside the session subtree",
      logger,
    );
  }
  return allow(agent, "set_label", target, "triage label within subtree", logger);
}

function validateUpdateState(
  agent: AgentId,
  caps: Capabilities,
  target: string | null,
  logger?: DecisionLogger,
): ValidationResult {
  // update_state is granted to nobody in v1.
  if (!caps.updateState) {
    return deny(
      agent,
      "update_state",
      target,
      "no agent may update issue state",
      logger,
    );
  }
  // Unreachable in v1; if ever granted, it would still be subtree-scoped above.
  return deny(agent, "update_state", target, "update_state not implemented", logger);
}

/**
 * Actor-gate (step 5). A session/label *trigger* is honored only if it came from
 * the operator's user id. Agent-originated triggers are ignored, with ONE
 * documented exception: a `mailman`-originated trigger that activates the
 * `researcher` is allowed (mailman → researcher).
 *
 * Returns `true` if the trigger should be honored, `false` if it must be ignored.
 * Deny by default: missing operator id, missing actor id, or an unknown
 * actor → not honored.
 */
export function isTriggerHonored(ctx: TriggerContext): boolean {
  const { operatorUserId, actorUserId } = ctx;
  if (!operatorUserId || !actorUserId) return false;

  // Operator-originated triggers are always honored.
  if (actorUserId === operatorUserId) return true;

  // The single documented agent-originated exception: mailman → researcher.
  const mailmanUserId = ctx.agentUserIds?.mailman;
  if (
    ctx.targetAgent === "researcher" &&
    mailmanUserId != null &&
    actorUserId === mailmanUserId
  ) {
    return true;
  }

  // Everything else agent-originated (or unrecognized) → ignored.
  return false;
}
