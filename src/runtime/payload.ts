import { createHash } from "node:crypto";
import { readObject, readString } from "../util.js";

export type LinearTriggerAction = "created" | "prompted";
export type LinearTriggerSource = "agent-session" | "comment";
export type LinearSubjectType = "issue" | "project" | "project-update" | "unknown";

export interface LinearTrigger {
  source: LinearTriggerSource;
  kind: string;
  action: LinearTriggerAction;
  sessionId: string;
  eventKey: string;
  webhookId: string;
  deliveryId: string;
  webhookTimestamp?: number;
  signal: string;
  prompt: string;
  promptContext: string;
  guidance: string;
  subjectType: LinearSubjectType;
  subjectId: string;
  subjectLabel: string;
  subjectUrl: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string;
  issueUrl: string;
  projectId: string;
  projectName: string;
  teamKey: string;
  projectKey: string;
  commentId: string;
  activityId: string;
}

export function normalizeLinearWebhookPayload(
  input: unknown,
): Record<string, unknown> {
  const root = readObject(input);
  if (!root) return {};
  const nested = readObject(root.data);
  if (!nested) return root;
  return { ...root, ...nested };
}

export function parseLinearTrigger(
  payload: Record<string, unknown>,
): LinearTrigger | null {
  const kind = readString(payload.type) ?? "";
  const action = resolveAction(payload);
  if (!action) return null;

  const session = readObject(payload.agentSession);
  const activity = readObject(payload.agentActivity);
  const comment = readObject(payload.comment);
  const sessionId =
    readString(payload.agentSessionId) ??
    readString(session?.id) ??
    readString(activity?.agentSessionId) ??
    readString(readObject(activity?.agentSession)?.id) ??
    readString(comment?.agentSessionId) ??
    readString(readObject(comment?.agentSession)?.id) ??
    "";
  if (!sessionId) return null;

  const issue =
    resolveIssueContext(payload) ??
    resolveIssueContext(session) ??
    resolveIssueContext(activity) ??
    resolveIssueContext(comment);
  const projectUpdate =
    resolveProjectUpdateContext(payload) ??
    resolveProjectUpdateContext(session) ??
    resolveProjectUpdateContext(activity) ??
    resolveProjectUpdateContext(comment);
  const project =
    resolveProjectContext(payload) ??
    resolveProjectContext(session) ??
    resolveProjectContext(activity) ??
    resolveProjectContext(comment) ??
    readObject(projectUpdate?.project) ??
    readObject(issue?.project);
  const issueTeam = readObject(issue?.team);
  const projectTeam = readObject(project?.team);
  const activityContent = readObject(activity?.content);
  const prompt =
    readString(activity?.body) ??
    readString(activityContent?.body) ??
    readString(payload.prompt) ??
    readString(comment?.body) ??
    readString(payload.body) ??
    readString(payload.message) ??
    "";
  const signal = readString(activity?.signal) ?? readString(payload.signal) ?? "";
  const promptContext =
    readString(payload.promptContext) ??
    readString(session?.promptContext) ??
    "";
  const guidance =
    readString(payload.guidance) ??
    readString(session?.guidance) ??
    "";
  const commentId =
    readString(comment?.id) ??
    (kind.toLowerCase() === "comment" ? readString(payload.id) ?? "" : "");
  const activityId = readString(activity?.id) ?? "";
  const deliveryId = readString(payload.linearDelivery) ?? "";
  const webhookId = readString(payload.webhookId) ?? "";
  const subject = resolveSubject(issue, project, projectUpdate);

  return {
    source: kind.toLowerCase() === "comment" ? "comment" : "agent-session",
    kind,
    action,
    sessionId,
    eventKey: resolveEventKey({
      action,
      sessionId,
      activityId,
      commentId,
      deliveryId,
      prompt,
      promptContext,
    }),
    webhookId,
    deliveryId,
    webhookTimestamp: normalizeWebhookTimestamp(payload.webhookTimestamp),
    signal,
    prompt,
    promptContext,
    guidance,
    subjectType: subject.type,
    subjectId: subject.id,
    subjectLabel: subject.label,
    subjectUrl: subject.url,
    issueId: readString(issue?.id) ?? "",
    issueIdentifier: readString(issue?.identifier) ?? "",
    issueTitle: readString(issue?.title) ?? "",
    issueDescription: readString(issue?.description) ?? "",
    issueUrl: readString(issue?.url) ?? "",
    projectId: readString(project?.id) ?? "",
    projectName: readString(project?.name) ?? "",
    teamKey:
      readString(issueTeam?.key) ??
      readString(projectTeam?.key) ??
      readString(issueTeam?.id) ??
      readString(projectTeam?.id) ??
      "",
    projectKey: readString(project?.key) ?? readString(project?.id) ?? "",
    commentId,
    activityId,
  };
}

export function resolveIssueContext(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  const direct = readObject(payload.issue);
  if (direct) return direct;

  const comment = readObject(payload.comment);
  const commentIssue = readObject(comment?.issue);
  if (commentIssue) return commentIssue;

  const issueId =
    readString(payload.issueId) ??
    readString(comment?.issueId) ??
    "";
  return issueId ? { id: issueId } : undefined;
}

export function resolveProjectContext(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!payload) return undefined;

  const direct = readObject(payload.project);
  if (direct) return direct;

  const comment = readObject(payload.comment);
  const commentProject = readObject(comment?.project);
  if (commentProject) return commentProject;

  const projectId =
    readString(payload.projectId) ??
    readString(comment?.projectId) ??
    "";
  if (projectId) return { id: projectId };

  const issue = readObject(payload.issue);
  const issueProject = readObject(issue?.project);
  if (issueProject) return issueProject;

  const projectUpdate = readObject(payload.projectUpdate);
  const projectUpdateProject = readObject(projectUpdate?.project);
  if (projectUpdateProject) return projectUpdateProject;

  const commentProjectUpdate = readObject(comment?.projectUpdate);
  return readObject(commentProjectUpdate?.project);
}

export function resolveProjectUpdateContext(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!payload) return undefined;

  const direct = readObject(payload.projectUpdate);
  if (direct) return direct;

  const comment = readObject(payload.comment);
  const commentProjectUpdate = readObject(comment?.projectUpdate);
  if (commentProjectUpdate) return commentProjectUpdate;

  const projectUpdateId =
    readString(payload.projectUpdateId) ??
    readString(comment?.projectUpdateId) ??
    "";
  return projectUpdateId ? { id: projectUpdateId } : undefined;
}

export function isProjectOnlyCommentPayload(
  payload: Record<string, unknown>,
): boolean {
  const kind = (readString(payload.type) ?? "").toLowerCase();
  if (kind !== "comment") return false;
  if (resolveIssueContext(payload)) return false;
  return Boolean(resolveProjectContext(payload) || resolveProjectUpdateContext(payload));
}

function resolveSubject(
  issue: Record<string, unknown> | undefined,
  project: Record<string, unknown> | undefined,
  projectUpdate: Record<string, unknown> | undefined,
): { type: LinearSubjectType; id: string; label: string; url: string } {
  if (issue) {
    const identifier = readString(issue.identifier) ?? "";
    const title = readString(issue.title) ?? "";
    return {
      type: "issue",
      id: readString(issue.id) ?? "",
      label: `${identifier} ${title}`.trim() || title || identifier,
      url: readString(issue.url) ?? "",
    };
  }

  if (projectUpdate) {
    const projectName = readString(project?.name) ?? "";
    const title =
      readString(projectUpdate.title) ??
      readString(projectUpdate.name) ??
      projectName;
    return {
      type: "project-update",
      id: readString(projectUpdate.id) ?? "",
      label: title ? `${title}`.trim() : "Project update",
      url: readString(projectUpdate.url) ?? readString(project?.url) ?? "",
    };
  }

  if (project) {
    const name = readString(project.name) ?? "";
    return {
      type: "project",
      id: readString(project.id) ?? "",
      label: name || "Project",
      url: readString(project.url) ?? "",
    };
  }

  return { type: "unknown", id: "", label: "", url: "" };
}

function resolveAction(
  payload: Record<string, unknown>,
): LinearTriggerAction | null {
  const kind = (readString(payload.type) ?? "").toLowerCase();
  const action = (readString(payload.action) ?? "").toLowerCase();

  if (kind === "comment") {
    if (
      payload.isArtificialAgentSessionRoot === true &&
      (action === "create" || action === "created")
    ) {
      return "created";
    }
    if (
      action === "create" ||
      action === "created" ||
      action === "update" ||
      action === "updated" ||
      action === "prompt" ||
      action === "prompted"
    ) {
      return "prompted";
    }
    return null;
  }

  if (action === "create" || action === "created") return "created";
  if (action === "prompt" || action === "prompted") return "prompted";
  return null;
}

function resolveEventKey(input: {
  action: LinearTriggerAction;
  sessionId: string;
  activityId: string;
  commentId: string;
  deliveryId: string;
  prompt: string;
  promptContext: string;
}): string {
  if (input.action === "created") {
    return `linear:session:${input.sessionId}:created`;
  }
  if (input.activityId) return `linear:activity:${input.activityId}`;
  if (input.commentId) return `linear:comment:${input.commentId}`;
  if (input.deliveryId) return `linear:delivery:${input.deliveryId}`;

  const digest = createHash("sha1")
    .update(`${input.sessionId}\n${input.prompt}\n${input.promptContext}`)
    .digest("hex")
    .slice(0, 16);
  return `linear:session:${input.sessionId}:prompt:${digest}`;
}

function normalizeWebhookTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value < 1e12 ? value * 1000 : value;
}
