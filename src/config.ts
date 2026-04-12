import type { PluginConfig } from "./types.js";

export function normalizeCfg(
  input: Record<string, unknown> | undefined,
): PluginConfig {
  const cfg = input ?? {};
  const agentId = readCfgString(cfg, "agentId");
  return {
    agentId,
    devAgentId: readCfgString(cfg, "devAgentId"),
    openclawProvider: readCfgString(cfg, "openclawProvider"),
    openclawModel: readCfgString(cfg, "openclawModel"),
    openclawThinking: readCfgString(cfg, "openclawThinking"),
    linearDebugToolTrace: readCfgBool(cfg, "linearDebugToolTrace"),
    linearWebhookSecret: readCfgString(cfg, "linearWebhookSecret"),
    linearApiKey: readCfgString(cfg, "linearApiKey"),
    linearOauthClientId: readCfgString(cfg, "linearOauthClientId"),
    linearOauthClientSecret: readCfgString(cfg, "linearOauthClientSecret"),
    linearOauthRedirectUri: readCfgString(cfg, "linearOauthRedirectUri"),
    linearTokenStorePath: readCfgString(cfg, "linearTokenStorePath"),
    repoByTeam: readCfgMap(cfg, "repoByTeam"),
    repoByProject: readCfgMap(cfg, "repoByProject"),
    defaultDir: readCfgString(cfg, "defaultDir"),
    delegateOnCreate: readCfgBool(cfg, "delegateOnCreate"),
    startOnCreate: readCfgBool(cfg, "startOnCreate"),
    externalUrlBase: readCfgString(cfg, "externalUrlBase"),
    externalUrlLabel: readCfgString(cfg, "externalUrlLabel"),
  };
}

function readCfgString(
  cfg: Record<string, unknown>,
  key: string,
): string | undefined {
  const raw = cfg[key];
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value || undefined;
}

function readCfgBool(
  cfg: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const raw = cfg[key];
  if (typeof raw !== "boolean") return undefined;
  return raw;
}

function readCfgMap(
  cfg: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const raw = cfg[key];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const map = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === "string" && v.trim()) {
      out[k] = v.trim();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

