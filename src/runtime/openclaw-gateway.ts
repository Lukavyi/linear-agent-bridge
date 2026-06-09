import type { OpenClawPluginApi, PluginConfig } from "../types.js";
import { readArray, readObject, readString } from "../util.js";
import { runGatewayTurn } from "./gateway.js";
import type {
  Gateway,
  GatewayEvent,
  GatewayResult,
  GatewayTurnInput,
} from "./gateway-types.js";

/**
 * Wraps the existing OpenClaw call surface behind the `Gateway` interface.
 *
 * Behavior is preserved exactly: it runs one OpenClaw turn, resolves the
 * visible reply the same way the runtime always has, and emits a single
 * `completion` event carrying that reply. No intermediate streaming events —
 * OpenClaw's response semantics stay byte-for-byte identical.
 */
export function createOpenClawGateway(): Gateway {
  return {
    backend: "openclaw",
    async *runTurn(
      api: OpenClawPluginApi,
      cfg: PluginConfig,
      input: GatewayTurnInput,
    ): AsyncGenerator<GatewayEvent, GatewayResult, void> {
      const raw = await runGatewayTurn(api, cfg, {
        agentId: input.agentId,
        sessionKey: input.sessionKey,
        label: input.label,
        message: input.prompt,
        idempotencyKey: input.idempotencyKey,
        extraSystemPrompt: input.extraSystemPrompt,
        timeoutMs: input.timeoutMs,
      });
      const reply = extractVisibleReply(raw);
      yield { type: "completion", body: reply };
      return {
        backend: "openclaw",
        ok: Boolean(reply),
        reply,
        raw,
      };
    },
  };
}

/**
 * Extracts the visible reply text from a raw OpenClaw gateway result.
 *
 * Concatenates payload text and media references, and treats a `NO_REPLY`
 * marker as no reply. Moved verbatim from the runtime handler so the parsing
 * of @Clawd's output is unchanged.
 */
export function extractVisibleReply(result: unknown): string {
  const root = readObject(result);
  if (!root) return "";
  const payloads = readArray(readObject(root.result)?.payloads);
  const parts: string[] = [];
  const seenMedia = new Set<string>();

  for (const entry of payloads) {
    const item = readObject(entry);
    if (!item) continue;
    const text = readString(item.text);
    if (text) parts.push(text);
    const directMedia = readString(item.mediaUrl);
    if (directMedia && !seenMedia.has(directMedia)) {
      seenMedia.add(directMedia);
      parts.push(`Media: ${directMedia}`);
    }
    const mediaUrls = readArray(item.mediaUrls);
    for (const mediaUrl of mediaUrls) {
      const value = readString(mediaUrl);
      if (value && !seenMedia.has(value)) {
        seenMedia.add(value);
        parts.push(`Media: ${value}`);
      }
    }
  }

  const reply = parts.join("\n\n").trim();
  if (!reply) return "";
  if (/\bNO_REPLY\b/i.test(reply)) return "";
  return reply;
}
