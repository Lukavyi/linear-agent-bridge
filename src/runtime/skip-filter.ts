import type { OpenClawPluginApi, PluginConfig } from "../types.js";
import { ISSUE_INFO_QUERY } from "../graphql/queries.js";
import { callLinear } from "../linear-client.js";
import { readObject, readString } from "../util.js";

const knownAgentUserIds = new Set<string>();

export function shouldSkipPromptedRun(prompt: string): string {
  const text = (prompt ?? "").trim();
  if (!text) return "empty-prompt";
  const lower = text.toLowerCase();
  const systemEcho = [
    /^received an update on\b/,
    /^starting work on\b/,
    /^stop request received\b/,
    /^agent run failed:/,
    /^working\s+\d{1,2}:\d{2}\b/,
    /^thinking\s+\d{1,2}:\d{2}\b/,
  ].some((re) => re.test(lower));
  return systemEcho ? "system-echo" : "";
}

export async function isSelfAuthoredComment(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  data: Record<string, unknown>,
): Promise<boolean> {
  if (data.isArtificialAgentSessionRoot === true) return true;

  const botActor = readObject(data.botActor);
  if (readString(botActor?.id)) return true;

  const comment = readObject(data.comment);
  const commentBotActor = readObject(comment?.botActor);
  if (readString(commentBotActor?.id)) return true;

  const author = resolveAuthor(data);
  if (!author.id && !author.name) return false;

  if (author.id && knownAgentUserIds.has(author.id)) return true;
  if (looksLikeAgentUserName(author.name)) {
    if (author.id) knownAgentUserIds.add(author.id);
    return true;
  }

  const issueId = resolveIssueId(data);
  if (!author.id || !issueId) return false;

  const delegatedAgentUserId = await resolveDelegatedAgentUserId(api, cfg, issueId);
  if (!delegatedAgentUserId || delegatedAgentUserId !== author.id) return false;

  knownAgentUserIds.add(author.id);
  return true;
}

function resolveAuthor(
  data: Record<string, unknown>,
): { id: string; name: string } {
  const user = readObject(data.user);
  if (user) {
    return {
      id: readString(user.id) ?? readString(data.userId) ?? "",
      name: readString(user.name) ?? "",
    };
  }

  const comment = readObject(data.comment);
  const commentUser = readObject(comment?.user);
  return {
    id:
      readString(commentUser?.id) ??
      readString(comment?.userId) ??
      readString(data.userId) ??
      "",
    name: readString(commentUser?.name) ?? "",
  };
}

function resolveIssueId(data: Record<string, unknown>): string {
  const issue = readObject(data.issue);
  if (readString(issue?.id)) return readString(issue?.id) ?? "";

  const comment = readObject(data.comment);
  const commentIssue = readObject(comment?.issue);
  return (
    readString(commentIssue?.id) ??
    readString(comment?.issueId) ??
    readString(data.issueId) ??
    ""
  );
}

function looksLikeAgentUserName(name: string): boolean {
  return /^openclaw$/i.test((name ?? "").trim());
}

async function resolveDelegatedAgentUserId(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  issueId: string,
): Promise<string> {
  const result = await callLinear(api, cfg, "issue(delegate)", {
    query: ISSUE_INFO_QUERY,
    variables: { id: issueId },
  });
  if (!result.ok) return "";

  const issue = readObject(result.data?.issue);
  const delegate = readObject(issue?.delegate);
  const delegateId = readString(delegate?.id) ?? "";
  const delegateName = readString(delegate?.name) ?? "";
  if (!delegateId || !looksLikeAgentUserName(delegateName)) return "";
  return delegateId;
}
