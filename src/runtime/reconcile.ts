import { AGENT_SESSION_RECONCILE_QUERY } from "../graphql/queries.js";
import { callLinear } from "../linear-client.js";
import type { OpenClawPluginApi, PluginConfig } from "../types.js";
import { readArray, readObject, readString } from "../util.js";
import type { LinearTrigger } from "./payload.js";

const DEFAULT_RECONCILE_LIMIT = 100;
const MAX_RECONCILE_LIMIT = 200;

interface SessionIssueInfo {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  teamKey: string;
  projectKey: string;
}

interface SessionCommentInfo {
  id: string;
  body: string;
  parentId: string;
}

export interface SessionActivityInfo {
  id: string;
  type: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionReconcileSnapshot {
  sessionId: string;
  status: string;
  issue: SessionIssueInfo;
  comment: SessionCommentInfo;
  sourceComment: SessionCommentInfo;
  activities: SessionActivityInfo[];
}

export interface ReconcileInput {
  sessionId: string;
  limit?: number;
  includeCreated?: boolean;
}

export interface ReconcilePlan {
  createdTrigger?: LinearTrigger;
  promptTriggers: LinearTrigger[];
}

export async function loadReconcileSnapshot(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  input: ReconcileInput,
): Promise<SessionReconcileSnapshot | null> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) return null;

  const first = clampReconcileLimit(input.limit);
  const result = await callLinear(api, cfg, "agentSession(reconcile)", {
    query: AGENT_SESSION_RECONCILE_QUERY,
    variables: { id: sessionId, first },
  });
  if (!result.ok) return null;

  const session = readObject(result.data?.agentSession);
  if (!session) return null;

  const issue = readObject(session.issue);
  const issueTeam = readObject(issue?.team);
  const issueProject = readObject(issue?.project);
  const comment = readObject(session.comment);
  const sourceComment = readObject(session.sourceComment);
  const activities = readArray(readObject(session.activities)?.nodes)
    .map(parseSessionActivity)
    .filter((entry): entry is SessionActivityInfo => Boolean(entry))
    .sort(compareActivities);

  return {
    sessionId,
    status: readString(session.status) ?? "",
    issue: {
      id: readString(issue?.id) ?? "",
      identifier: readString(issue?.identifier) ?? "",
      title: readString(issue?.title) ?? "",
      description: readString(issue?.description) ?? "",
      url: readString(issue?.url) ?? "",
      teamKey: readString(issueTeam?.key) ?? readString(issueTeam?.id) ?? "",
      projectKey:
        readString(issueProject?.key) ?? readString(issueProject?.id) ?? "",
    },
    comment: parseComment(comment),
    sourceComment: parseComment(sourceComment),
    activities,
  };
}

export function buildReconcilePlan(input: {
  snapshot: SessionReconcileSnapshot;
  includeCreated?: boolean;
  isEventProcessed: (eventKey: string) => boolean;
}): ReconcilePlan {
  const { snapshot, isEventProcessed } = input;
  const includeCreated = input.includeCreated !== false;
  const promptActivities = findUnhandledPromptActivities(snapshot.activities);

  const promptTriggers = promptActivities
    .map((activity) => buildPromptTrigger(snapshot, activity))
    .filter((trigger) => !isEventProcessed(trigger.eventKey));

  const createdTrigger = includeCreated
    ? buildCreatedTriggerIfNeeded(snapshot, promptTriggers.length > 0, isEventProcessed)
    : undefined;

  return {
    createdTrigger,
    promptTriggers,
  };
}

export function findUnhandledPromptActivities(
  activities: SessionActivityInfo[],
): SessionActivityInfo[] {
  const out: SessionActivityInfo[] = [];

  for (let index = 0; index < activities.length; index += 1) {
    const current = activities[index];
    if (current.type !== "prompt") continue;

    let handled = false;
    for (let cursor = index + 1; cursor < activities.length; cursor += 1) {
      const next = activities[cursor];
      if (next.type === "prompt") break;
      handled = true;
      break;
    }

    if (!handled) out.push(current);
  }

  return out;
}

function buildCreatedTriggerIfNeeded(
  snapshot: SessionReconcileSnapshot,
  hasUnhandledPrompts: boolean,
  isEventProcessed: (eventKey: string) => boolean,
): LinearTrigger | undefined {
  const hasAnyActivities = snapshot.activities.length > 0;
  const hasAgentActivity = snapshot.activities.some((entry) => entry.type !== "prompt");
  if (hasAnyActivities || hasAgentActivity || hasUnhandledPrompts) return undefined;

  const trigger = baseTrigger(snapshot);
  trigger.action = "created";
  trigger.eventKey = `linear:session:${snapshot.sessionId}:created`;
  trigger.promptContext = buildSyntheticPromptContext(snapshot);
  if (isEventProcessed(trigger.eventKey)) return undefined;
  return trigger;
}

function buildPromptTrigger(
  snapshot: SessionReconcileSnapshot,
  activity: SessionActivityInfo,
): LinearTrigger {
  const trigger = baseTrigger(snapshot);
  trigger.action = "prompted";
  trigger.prompt = activity.text;
  trigger.activityId = activity.id;
  trigger.eventKey = `linear:activity:${activity.id}`;
  return trigger;
}

function baseTrigger(snapshot: SessionReconcileSnapshot): LinearTrigger {
  const subjectLabel = `${snapshot.issue.identifier} ${snapshot.issue.title}`.trim();
  return {
    source: "agent-session",
    kind: "AgentSessionEvent",
    action: "prompted",
    sessionId: snapshot.sessionId,
    eventKey: "",
    webhookId: "manual-reconcile",
    deliveryId: "manual-reconcile",
    signal: "",
    prompt: "",
    promptContext: "",
    guidance: "",
    subjectType: snapshot.issue.id ? "issue" : "unknown",
    subjectId: snapshot.issue.id,
    subjectLabel,
    subjectUrl: snapshot.issue.url,
    issueId: snapshot.issue.id,
    issueIdentifier: snapshot.issue.identifier,
    issueTitle: snapshot.issue.title,
    issueDescription: snapshot.issue.description,
    issueUrl: snapshot.issue.url,
    projectId: "",
    projectName: "",
    teamKey: snapshot.issue.teamKey,
    projectKey: snapshot.issue.projectKey,
    commentId: snapshot.comment.id || snapshot.sourceComment.id,
    activityId: "",
  };
}

function buildSyntheticPromptContext(snapshot: SessionReconcileSnapshot): string {
  const parts = [
    snapshot.issue.identifier || snapshot.issue.title
      ? `<issue identifier="${escapeXml(snapshot.issue.identifier)}">\n<title>${escapeXml(snapshot.issue.title)}</title>\n<description>${escapeXml(snapshot.issue.description)}</description>\n</issue>`
      : "",
    snapshot.sourceComment.body
      ? `<source-comment>${escapeXml(snapshot.sourceComment.body)}</source-comment>`
      : "",
    snapshot.comment.body
      ? `<comment>${escapeXml(snapshot.comment.body)}</comment>`
      : "",
  ].filter(Boolean);

  return parts.join("\n\n");
}

function parseSessionActivity(input: unknown): SessionActivityInfo | null {
  const node = readObject(input);
  const id = readString(node?.id) ?? "";
  if (!id) return null;

  const content = readObject(node?.content);
  const typename = readString(content?.__typename) ?? "Activity";
  const action = readString(content?.action);
  const parameter = readString(content?.parameter);
  const result = readString(content?.result);
  const body = readString(content?.body);
  const text = [body, action ? [action, parameter, result].filter(Boolean).join(" | ") : ""]
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    id,
    type: normalizeActivityType(typename),
    text,
    createdAt: readString(node?.createdAt) ?? "",
    updatedAt: readString(node?.updatedAt) ?? "",
  };
}

function parseComment(input: Record<string, unknown> | undefined): SessionCommentInfo {
  return {
    id: readString(input?.id) ?? "",
    body: readString(input?.body) ?? "",
    parentId: readString(input?.parentId) ?? "",
  };
}

function normalizeActivityType(typename: string): string {
  const raw = typename.replace(/^AgentActivity/, "").replace(/Content$/, "");
  return raw ? raw.toLowerCase() : "activity";
}

function compareActivities(a: SessionActivityInfo, b: SessionActivityInfo): number {
  if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
    return a.createdAt.localeCompare(b.createdAt);
  }
  if (a.updatedAt && b.updatedAt && a.updatedAt !== b.updatedAt) {
    return a.updatedAt.localeCompare(b.updatedAt);
  }
  return a.id.localeCompare(b.id);
}

function clampReconcileLimit(input: number | undefined): number {
  if (!Number.isFinite(input)) return DEFAULT_RECONCILE_LIMIT;
  return Math.max(1, Math.min(MAX_RECONCILE_LIMIT, Math.trunc(input as number)));
}

function escapeXml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
