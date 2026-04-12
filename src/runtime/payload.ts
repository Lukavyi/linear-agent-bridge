import { createHash } from "node:crypto";
import { readObject, readString } from "../util.js";

export type LinearTriggerAction = "created" | "prompted";
export type LinearTriggerSource = "agent-session" | "comment";

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
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string;
  issueUrl: string;
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
    readObject(payload.issue) ??
    readObject(session?.issue) ??
    readObject(activity?.issue) ??
    readObject(comment?.issue);
  const issueTeam = readObject(issue?.team);
  const issueProject = readObject(issue?.project);
  const activityContent = readObject(activity?.content);
  const prompt =
    readString(activity?.body) ??
    readString(activityContent?.body) ??
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
    issueId: readString(issue?.id) ?? "",
    issueIdentifier: readString(issue?.identifier) ?? "",
    issueTitle: readString(issue?.title) ?? "",
    issueDescription: readString(issue?.description) ?? "",
    issueUrl: readString(issue?.url) ?? "",
    teamKey: readString(issueTeam?.key) ?? readString(issueTeam?.id) ?? "",
    projectKey: readString(issueProject?.key) ?? readString(issueProject?.id) ?? "",
    commentId,
    activityId,
  };
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
