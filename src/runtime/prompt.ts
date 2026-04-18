import type { PluginConfig } from "../types.js";
import type { LinearTrigger } from "./payload.js";

export interface HistoryEntry {
  type: string;
  text: string;
  updatedAt?: string;
}

export interface IssueCommentEntry {
  author: string;
  text: string;
}

export function buildTurnMessage(input: {
  cfg: PluginConfig;
  trigger: LinearTrigger;
  history: HistoryEntry[];
  issueComments?: IssueCommentEntry[];
}): string {
  const { cfg, trigger, history, issueComments = [] } = input;
  const workspace = resolveSuggestedWorkspace(cfg, trigger);
  const issueContextBlock = formatIssueContext(trigger, issueComments);
  const historyBlock = formatHistory(history);
  const currentTurn = resolveCurrentTurn(trigger, history);

  return [
    "You are replying inside a native Linear agent session.",
    "Linear AgentSession and AgentActivity are the source of truth for this conversation.",
    "Comments are only the visible surface, not the canonical history.",
    "",
    "Turn contract:",
    "- Continue the same conversation naturally using the persistent OpenClaw session for this Linear session.",
    "- Return exactly one normal user-visible final reply for this turn.",
    "- Do not return NO_REPLY.",
    "- Default to a direct conversational answer.",
    "- Only take agentic actions, edit files, or run commands when the user's current turn explicitly asks for that work.",
    "- Do not use sessions_yield unless the user explicitly asks for deferred completion.",
    "- Do not spawn subagents unless the user explicitly asks for delegation.",
    "",
    "Linear context:",
    `- Session ID: ${trigger.sessionId}`,
    `- Source: ${trigger.source}`,
    `- Action: ${trigger.action}`,
    trigger.issueIdentifier || trigger.issueTitle
      ? `- Issue: ${`${trigger.issueIdentifier} ${trigger.issueTitle}`.trim()}`
      : "",
    trigger.issueUrl ? `- Issue URL: ${trigger.issueUrl}` : "",
    workspace ? `- Suggested workspace: ${workspace}` : "",
    trigger.guidance ? `- Guidance: ${trigger.guidance}` : "",
    "",
    issueContextBlock,
    historyBlock,
    currentTurn
      ? `Current user turn:\n${currentTurn}`
      : "Current user turn:\nNo direct prompt body was included in the webhook. Use the session context and activity history, and if still ambiguous ask one concise clarifying question.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildExtraSystemPrompt(): string {
  return [
    "You are the main OpenClaw assistant speaking through Linear.",
    "Honor Linear's native session/activity model.",
    "Return exactly one visible final answer for this turn.",
    "Never return NO_REPLY.",
    "Default to a direct conversational answer.",
    "Only take agentic actions, edit files, or run commands when the user's current turn explicitly asks for that work.",
    "Do not use sessions_yield unless the user explicitly requests deferred completion.",
    "Do not spawn subagents unless the user explicitly asks for delegation or subagents.",
    "If the user asked for work, you may do that work in the same turn, but still finish with a concise visible result or blocker.",
  ].join(" ");
}

function resolveCurrentTurn(
  trigger: LinearTrigger,
  history: HistoryEntry[],
): string {
  const direct = trigger.prompt.trim();
  if (direct) return direct;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.type !== "prompt") continue;
    const text = entry.text.trim();
    if (text) return text;
  }

  return "";
}

function formatIssueContext(
  trigger: LinearTrigger,
  issueComments: IssueCommentEntry[],
): string {
  const sections: string[] = [];
  const description = trigger.issueDescription.trim();
  if (description) {
    sections.push(`Issue description:\n${description}`);
  }
  if (issueComments.length > 0) {
    const recent = issueComments.slice(-8);
    const lines = recent.map((entry) => `- ${entry.author}: ${entry.text}`);
    sections.push(`Recent issue comments:\n${lines.join("\n")}`);
  }
  if (sections.length === 0) return "";
  return `Issue context:\n${sections.join("\n\n")}`;
}

function formatHistory(history: HistoryEntry[]): string {
  if (history.length === 0) return "";
  const recent = history.slice(-12);
  const lines = recent.map((entry) => `- [${entry.type}] ${entry.text}`);
  return `Recent AgentActivity history:\n${lines.join("\n")}`;
}

function resolveSuggestedWorkspace(
  cfg: PluginConfig,
  trigger: LinearTrigger,
): string {
  if (trigger.projectKey && cfg.repoByProject?.[trigger.projectKey]) {
    return cfg.repoByProject[trigger.projectKey];
  }
  if (trigger.teamKey && cfg.repoByTeam?.[trigger.teamKey]) {
    return cfg.repoByTeam[trigger.teamKey];
  }
  return cfg.defaultDir ?? "";
}
