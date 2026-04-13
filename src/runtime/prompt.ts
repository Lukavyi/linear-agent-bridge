import type { PluginConfig } from "../types.js";
import type { LinearTrigger } from "./payload.js";

export interface HistoryEntry {
  type: string;
  text: string;
  updatedAt?: string;
}

export function buildTurnMessage(input: {
  cfg: PluginConfig;
  trigger: LinearTrigger;
  history: HistoryEntry[];
}): string {
  const { cfg, trigger, history } = input;
  const workspace = resolveSuggestedWorkspace(cfg, trigger);
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
    formatSubjectLine(trigger),
    formatSubjectUrlLine(trigger),
    workspace ? `- Suggested workspace: ${workspace}` : "",
    trigger.guidance ? `- Guidance: ${trigger.guidance}` : "",
    "",
    trigger.promptContext
      ? `Prompt context from Linear:\n${trigger.promptContext}`
      : "",
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

function formatSubjectLine(trigger: LinearTrigger): string {
  if (trigger.issueIdentifier || trigger.issueTitle) {
    return `- Issue: ${`${trigger.issueIdentifier} ${trigger.issueTitle}`.trim()}`;
  }
  if (trigger.subjectType === "project-update") {
    return `- Project update: ${trigger.subjectLabel || trigger.projectName || trigger.subjectId}`;
  }
  if (trigger.projectName || trigger.subjectType === "project") {
    return `- Project: ${trigger.projectName || trigger.subjectLabel || trigger.projectId}`;
  }
  if (trigger.subjectLabel) {
    return `- Subject: ${trigger.subjectLabel}`;
  }
  return "";
}

function formatSubjectUrlLine(trigger: LinearTrigger): string {
  if (trigger.issueUrl) return `- Issue URL: ${trigger.issueUrl}`;
  if (trigger.subjectUrl) return `- Subject URL: ${trigger.subjectUrl}`;
  return "";
}
