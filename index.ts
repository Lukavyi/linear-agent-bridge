import type { OpenClawPluginApi } from "./src/types.js";
import { createLinearWebhook } from "./src/runtime/handler.js";
import { createLinearOauthRoute } from "./src/oauth/route.js";

function register(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: "/plugins/linear/linear",
    handler: createLinearWebhook(api),
    auth: "plugin" as const,
  });

  api.registerHttpRoute({
    path: "/plugins/linear/oauth/callback",
    handler: createLinearOauthRoute(api),
    auth: "plugin" as const,
  });

  api.registerHttpRoute({
    path: "/plugins/linear/oauth/exchange",
    handler: createLinearOauthRoute(api),
    auth: "plugin" as const,
  });
}

export default {
  id: "linear-agent-bridge",
  name: "Linear",
  description: "Linear conversational bridge for the OpenClaw main agent",
  register,
};
