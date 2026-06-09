import type { ActivityContent } from "../types.js";
import type { GatewayEvent } from "./gateway-types.js";

/**
 * Posted as a terminal `error` when a turn finishes without a visible reply.
 * Kept verbatim so @Clawd's existing failure output is byte-for-byte unchanged.
 */
export const NO_REPLY_MESSAGE =
  "This run finished without a visible reply. The model returned no publishable answer, so the bridge is marking the turn as failed.";

/**
 * Universal mapper: `GatewayEvent` → Linear activity payload.
 *
 * The single place the runtime constructs activity content from gateway
 * output. Every backend feeds it; OpenClaw simply emits fewer events.
 * Returns `null` when an event carries nothing worth publishing.
 */
export function mapGatewayEventToActivity(
  event: GatewayEvent,
): ActivityContent | null {
  switch (event.type) {
    case "thought": {
      const body = event.body.trim();
      return body ? { type: "thought", body } : null;
    }
    case "action": {
      const action = event.action.trim();
      if (!action) return null;
      const content: ActivityContent = { type: "action", action };
      if (event.parameter) content.parameter = event.parameter;
      if (event.result) content.result = event.result;
      return content;
    }
    case "completion": {
      const body = event.body.trim();
      return body
        ? { type: "response", body }
        : { type: "error", body: NO_REPLY_MESSAGE };
    }
    default:
      return null;
  }
}
