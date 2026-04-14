import type { OpenClawPluginApi } from "./src/types.js";
import {
  createLinearReconcileRoute,
  createLinearWebhook,
} from "./src/runtime/handler.js";
import { createLinearOauthRoute } from "./src/oauth/route.js";

export default function register(api: OpenClawPluginApi): void {
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

  api.registerHttpRoute({
    path: "/plugins/linear/reconcile",
    handler: createLinearReconcileRoute(api),
    auth: "gateway" as const,
  });
}
