import http, { IncomingMessage, ServerResponse } from "node:http";

import linearPlugin from "./index.js";
import type { OpenClawPluginApi } from "./src/types.js";

/**
 * Standalone entrypoint for the Linear bridge.
 *
 * @Clawd runs this codebase as an OpenClaw plugin (the host supplies the HTTP
 * router, logger, and config). The @Hermes deployment has no OpenClaw to host
 * it, so this minimal server provides the same `OpenClawPluginApi` surface —
 * an HTTP server that dispatches the plugin's registered routes, a console
 * logger, and config drawn from environment variables — and then runs the
 * plugin's `register()`. With `BACKEND=hermes` the plugin never touches
 * OpenClaw's `callGateway`, so nothing here depends on a local OpenClaw.
 */

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const DEBUG =
  process.env.LINEAR_DEBUG === "1" || process.env.LINEAR_DEBUG === "true";

/**
 * Builds the plugin config object (the shape `normalizeCfg` consumes) from env.
 * An optional `PLUGIN_CONFIG_JSON` blob is the base; explicit env keys override.
 */
function buildPluginConfig(): Record<string, unknown> {
  const env = process.env;
  const config: Record<string, unknown> = {};

  if (env.PLUGIN_CONFIG_JSON?.trim()) {
    try {
      Object.assign(config, JSON.parse(env.PLUGIN_CONFIG_JSON));
    } catch (error) {
      console.warn(
        `[linear] PLUGIN_CONFIG_JSON is not valid JSON, ignoring: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const str = (key: string, envKey: string): void => {
    const value = env[envKey]?.trim();
    if (value) config[key] = value;
  };
  const bool = (key: string, envKey: string): void => {
    const value = env[envKey]?.trim().toLowerCase();
    if (value === "true" || value === "1") config[key] = true;
    else if (value === "false" || value === "0") config[key] = false;
  };
  const jsonMap = (key: string, envKey: string): void => {
    const raw = env[envKey]?.trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") config[key] = parsed;
    } catch {
      console.warn(`[linear] ${envKey} is not valid JSON, ignoring.`);
    }
  };

  str("agentId", "AGENT_ID");
  str("devAgentId", "DEV_AGENT_ID");
  str("openclawProvider", "OPENCLAW_PROVIDER");
  str("openclawModel", "OPENCLAW_MODEL");
  str("openclawThinking", "OPENCLAW_THINKING");
  bool("linearDebugToolTrace", "LINEAR_DEBUG_TOOL_TRACE");
  str("linearWebhookSecret", "LINEAR_WEBHOOK_SECRET");
  str("linearApiKey", "LINEAR_API_KEY");
  str("linearOauthClientId", "LINEAR_OAUTH_CLIENT_ID");
  str("linearOauthClientSecret", "LINEAR_OAUTH_CLIENT_SECRET");
  str("linearOauthRedirectUri", "LINEAR_OAUTH_REDIRECT_URI");
  str("linearTokenStorePath", "LINEAR_TOKEN_STORE_PATH");
  str("hermesContinuationStorePath", "HERMES_CONTINUATION_STORE_PATH");
  str("defaultDir", "DEFAULT_DIR");
  str("externalUrlBase", "EXTERNAL_URL_BASE");
  str("externalUrlLabel", "EXTERNAL_URL_LABEL");
  bool("delegateOnCreate", "DELEGATE_ON_CREATE");
  bool("startOnCreate", "START_ON_CREATE");
  jsonMap("repoByTeam", "REPO_BY_TEAM");
  jsonMap("repoByProject", "REPO_BY_PROJECT");

  return config;
}

function buildApi(routes: Map<string, RouteHandler>): OpenClawPluginApi {
  return {
    pluginConfig: buildPluginConfig(),
    logger: {
      info: (msg) => console.info(`[linear] ${msg}`),
      warn: (msg) => console.warn(`[linear] ${msg}`),
      error: (msg) => console.error(`[linear] ${msg}`),
      debug: DEBUG ? (msg) => console.debug(`[linear] ${msg}`) : undefined,
    },
    registerHttpRoute: ({ path, handler }) => {
      routes.set(path, handler);
      console.info(`[linear] registered route ${path}`);
    },
  };
}

function main(): void {
  const routes = new Map<string, RouteHandler>();
  const api = buildApi(routes);

  // Boots the gateway (BACKEND selector) and registers the plugin's routes.
  // Fails fast here if e.g. BACKEND=hermes but HERMES_URL is missing.
  linearPlugin.register(api);

  const server = http.createServer((req, res) => {
    const pathname = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    ).pathname;

    if (req.method === "GET" && (pathname === "/" || pathname === "/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: linearPlugin.id }));
      return;
    }

    const handler = routes.get(pathname);
    if (!handler) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Not Found" }));
      return;
    }

    Promise.resolve(handler(req, res)).catch((error) => {
      console.error(
        `[linear] route ${pathname} threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Internal Server Error" }));
      }
    });
  });

  server.listen(PORT, () => {
    console.info(`[linear] ${linearPlugin.name} bridge listening on :${PORT}`);
  });
}

main();
