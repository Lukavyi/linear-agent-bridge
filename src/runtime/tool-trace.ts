import type { ActivityContent } from "../types.js";
import { readArray, readNumber, readObject, readString } from "../util.js";

const TOOL_TRACE_SLOP_MS = 1500;
const TOOL_TRACE_MAX_LINES = 60;
const TOOL_TRACE_CHUNK_LINES = 8;
const TOOL_TRACE_VALUE_MAX = 160;
const TOOL_TRACE_RESULT_MAX = 100;

interface ToolCallEntry {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
}

export function buildToolTraceActivities(
  messages: unknown[],
  opts: { startedAtMs: number; maxLines?: number },
): ActivityContent[] {
  const lines = extractToolTraceLines(messages, opts.startedAtMs);
  if (lines.length === 0) return [];

  const maxLines = Math.max(1, opts.maxLines ?? TOOL_TRACE_MAX_LINES);
  const selected = lines.slice(0, maxLines);
  const omitted = Math.max(0, lines.length - selected.length);
  const activities: ActivityContent[] = [];

  for (let index = 0; index < selected.length; index += TOOL_TRACE_CHUNK_LINES) {
    const chunk = selected.slice(index, index + TOOL_TRACE_CHUNK_LINES);
    const title = index === 0 ? "Tool trace" : "Tool trace (cont.)";
    activities.push({
      type: "thought",
      body: [title, ...chunk.map((line) => `- ${line}`)].join("\n"),
    });
  }

  if (omitted > 0) {
    activities.push({
      type: "thought",
      body: `Tool trace truncated, ${omitted} more tool call${omitted === 1 ? "" : "s"}.`,
    });
  }

  return activities;
}

function extractToolTraceLines(messages: unknown[], startedAtMs: number): string[] {
  const calls: ToolCallEntry[] = [];
  const results = new Map<string, string>();

  for (const rawMessage of messages) {
    const message = readObject(rawMessage);
    if (!message) continue;
    const timestampMs = parseTimestampMs(message);
    if (
      typeof timestampMs === "number" &&
      timestampMs + TOOL_TRACE_SLOP_MS < startedAtMs
    ) {
      continue;
    }

    const role = readString(message.role) ?? "";
    if (role === "assistant") {
      for (const block of readArray(message.content)) {
        const entry = readObject(block);
        if (!entry || readString(entry.type) !== "toolCall") continue;
        const id = readString(entry.id) ?? "";
        const toolName = readString(entry.name) ?? "tool";
        const args = readObject(entry.arguments) ?? {};
        calls.push({ id, toolName, args });
      }
      continue;
    }

    if (role === "toolResult") {
      const toolCallId = readString(message.toolCallId) ?? "";
      if (!toolCallId) continue;
      const summary = summarizeToolResult(message);
      if (summary) results.set(toolCallId, summary);
    }
  }

  return calls.map((call) => {
    const target = summarizeToolTarget(call.toolName, call.args);
    const result = results.get(call.id);
    return [call.toolName, target, result && result !== "ok" ? `-> ${result}` : ""]
      .filter(Boolean)
      .join(" ")
      .trim();
  });
}

function parseTimestampMs(message: Record<string, unknown>): number | undefined {
  const raw = readString(message.timestamp);
  if (!raw) return undefined;
  const timestampMs = Date.parse(raw);
  return Number.isFinite(timestampMs) ? timestampMs : undefined;
}

function summarizeToolTarget(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const preferredKeys = resolvePreferredKeys(toolName);
  for (const key of preferredKeys) {
    const value = formatArgValue(key, args[key]);
    if (value) return value;
  }

  const fallback = truncate(safeJson(args), TOOL_TRACE_VALUE_MAX);
  return fallback || "";
}

function resolvePreferredKeys(toolName: string): string[] {
  switch (toolName) {
    case "read":
    case "write":
    case "edit":
      return ["path"];
    case "apply_patch":
      return ["input"];
    case "exec":
      return ["command"];
    case "web_fetch":
      return ["url"];
    case "web_search":
      return ["query"];
    case "browser":
      return ["url", "targetUrl", "selector", "ref"];
    case "pdf":
      return ["pdf", "pages"];
    case "image":
      return ["image", "images"];
    default:
      return [
        "path",
        "filePath",
        "url",
        "query",
        "command",
        "sessionKey",
        "cwd",
        "target",
        "ref",
        "text",
      ];
  }
}

function formatArgValue(key: string, value: unknown): string {
  if (typeof value === "string") {
    if (!value.trim()) return "";
    if (key === "path" || key === "filePath") {
      return formatPath(value);
    }
    if (key === "query" || key === "text") {
      return quote(truncate(value.trim(), TOOL_TRACE_VALUE_MAX));
    }
    if (key === "command" || key === "input") {
      return truncate(flattenWhitespace(value), TOOL_TRACE_VALUE_MAX);
    }
    return truncate(value.trim(), TOOL_TRACE_VALUE_MAX);
  }

  if (Array.isArray(value)) {
    const items = value
      .map((entry) => formatArgValue(key, entry))
      .filter(Boolean);
    if (items.length === 0) return "";
    return truncate(items.join(", "), TOOL_TRACE_VALUE_MAX);
  }

  if (value && typeof value === "object") {
    return truncate(safeJson(value), TOOL_TRACE_VALUE_MAX);
  }

  return "";
}

function summarizeToolResult(message: Record<string, unknown>): string {
  const details = readObject(message.details);
  const payload = parseJsonText(readFirstText(message));

  const error =
    readString(details?.error) ??
    readString(readObject(payload)?.error);
  if (error) {
    return `error: ${truncate(flattenWhitespace(error), TOOL_TRACE_RESULT_MAX)}`;
  }

  const statusText =
    readString(details?.status) ??
    readString(readObject(payload)?.status);
  if (statusText && statusText !== "ok" && statusText !== "success") {
    return truncate(statusText, TOOL_TRACE_RESULT_MAX);
  }

  const statusCode =
    readNumber(details?.status) ??
    readNumber(readObject(payload)?.status);
  if (typeof statusCode === "number" && statusCode >= 400) {
    return `status ${statusCode}`;
  }

  if (message.isError === true) return "error";
  return "ok";
}

function readFirstText(message: Record<string, unknown>): string {
  for (const block of readArray(message.content)) {
    const entry = readObject(block);
    const text = readString(entry?.text);
    if (text) return text;
  }
  return "";
}

function parseJsonText(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    return readObject(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function formatPath(input: string): string {
  const normalized = input.replace(/^\/Users\/[^/]+/, "~");
  if (normalized.length <= TOOL_TRACE_VALUE_MAX) return normalized;
  return `…${normalized.slice(-(TOOL_TRACE_VALUE_MAX - 1))}`;
}

function safeJson(value: unknown): string {
  try {
    return flattenWhitespace(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function flattenWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function quote(value: string): string {
  return value.includes("\"") ? value : `"${value}"`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}
