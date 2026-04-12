import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawPluginApi, PluginConfig } from "../types.js";

const callRef: {
  value?: (opts: Record<string, unknown>) => Promise<unknown>;
} = {};

export interface GatewayTurnParams {
  agentId: string;
  sessionKey: string;
  label: string;
  message: string;
  idempotencyKey: string;
  extraSystemPrompt: string;
  timeoutMs: number;
}

export async function runGatewayTurn(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  params: GatewayTurnParams,
): Promise<unknown> {
  const call = await loadCallGateway(api);
  const requestParams: Record<string, unknown> = {
    message: params.message,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    label: params.label,
    idempotencyKey: params.idempotencyKey,
    thinking: cfg.openclawThinking ?? "high",
    extraSystemPrompt: params.extraSystemPrompt,
  };
  if (cfg.openclawProvider) requestParams.provider = cfg.openclawProvider;
  if (cfg.openclawModel) requestParams.model = cfg.openclawModel;
  const request = {
    method: "agent",
    params: requestParams,
    expectFinal: true,
    timeoutMs: params.timeoutMs,
  };

  try {
    return await call(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!shouldRetryWithoutModelOverride(message)) {
      throw error;
    }
    api.logger.warn?.(
      "linear runtime: gateway rejected provider/model override; retrying with agent defaults",
    );
    return await call({
      method: "agent",
      params: {
        message: params.message,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        label: params.label,
        idempotencyKey: params.idempotencyKey,
        thinking: cfg.openclawThinking ?? "high",
        extraSystemPrompt: params.extraSystemPrompt,
      },
      expectFinal: true,
      timeoutMs: params.timeoutMs,
    });
  }
}

export async function readGatewayHistory(
  api: OpenClawPluginApi,
  params: { sessionKey: string; limit?: number },
): Promise<unknown[]> {
  const call = await loadCallGateway(api);
  const result = await call({
    method: "chat.history",
    params: {
      sessionKey: params.sessionKey,
      limit: params.limit ?? 250,
    },
  });
  const messages = (result as { messages?: unknown[] } | null | undefined)?.messages;
  return Array.isArray(messages) ? messages : [];
}

function shouldRetryWithoutModelOverride(message: string): boolean {
  return message.includes("provider/model overrides are not authorized");
}

async function loadCallGateway(
  api: OpenClawPluginApi,
): Promise<(opts: Record<string, unknown>) => Promise<unknown>> {
  if (callRef.value) return callRef.value;
  try {
    const argv1 =
      typeof process?.argv?.[1] === "string" ? process.argv[1] : "";
    const distDir = argv1 ? path.dirname(argv1) : "";
    if (distDir && fs.existsSync(distDir)) {
      const files = fs
        .readdirSync(distDir)
        .filter((name) => name.startsWith("call-") && name.endsWith(".js"))
        .sort((a, b) =>
          a.startsWith("call--") === b.startsWith("call--")
            ? 0
            : a.startsWith("call--")
              ? 1
              : -1,
        );
      for (const file of files) {
        try {
          const mod = await import(pathToFileURL(path.join(distDir, file)).href);
          const fn = mod?.callGateway as
            | ((...args: unknown[]) => unknown)
            | undefined;
          if (typeof fn === "function") {
            const auth = api.config?.gateway?.auth ?? {};
            const token =
              typeof auth.token === "string" ? auth.token.trim() : undefined;
            const password =
              typeof auth.password === "string"
                ? auth.password.trim()
                : undefined;
            callRef.value = ((opts: Record<string, unknown>) =>
              fn({
                ...opts,
                token: (opts.token as string | undefined) ?? token,
                password: (opts.password as string | undefined) ?? password,
              })) as (opts: Record<string, unknown>) => Promise<unknown>;
            return callRef.value;
          }
        } catch (error) {
          api.logger.debug?.(
            `linear runtime: callGateway import failed (${file}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  } catch (error) {
    api.logger.warn?.(
      `linear runtime: failed to locate gateway callGateway: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (api.callGateway && typeof api.callGateway === "function") {
    callRef.value = api.callGateway as (opts: Record<string, unknown>) => Promise<unknown>;
    return callRef.value;
  }
  throw new Error(
    "callGateway not available. Ensure the plugin is running inside an OpenClaw gateway process.",
  );
}
