import type { OpenClawPluginApi, PluginConfig } from "../types.js";
import { readArray, readObject, readString } from "../util.js";
import type {
  Gateway,
  GatewayEvent,
  GatewayResult,
  GatewayTurnInput,
} from "./gateway-types.js";

/**
 * Resolved connection settings for the Hermes `api_server`.
 *
 * `url` points at the private Railway service (e.g.
 * `http://hermes-agent.railway.internal:8642`); `apiKey` is the Hermes
 * `API_SERVER_KEY`. `model` is the OpenAI-compatible model name Hermes expects
 * (default `hermes-agent`). `fetchImpl` is injectable so tests can run against
 * an in-process mock server.
 */
export interface HermesGatewayConfig {
  url: string;
  apiKey: string;
  model: string;
  fetchImpl: typeof fetch;
}

const ACK_THOUGHT = "Working on it…";
const DEFAULT_MODEL = "hermes-agent";

/**
 * Minimal `HermesGateway` — the walking-skeleton backend for @Hermes.
 *
 * Hermes' `api_server` is OpenAI-compatible, so one turn is a single
 * `POST /v1/chat/completions` (Bearer auth) carrying the bridge-built prompt as
 * the user message. The gateway emits an immediate ack `thought`, then the
 * model's reply (`choices[0].message.content`) as one `completion`.
 *
 * Non-streaming and stateless by design — the bridge already folds session
 * history into the prompt. Intermediate tool-progress streaming and server-side
 * session continuity (`/v1/responses` + `previous_response_id`) are follow-up
 * slices; so are throttling, cancellation, and rich error mapping.
 */
export function createHermesGateway(
  config?: Partial<HermesGatewayConfig>,
): Gateway {
  const url = normalizeBaseUrl(config?.url ?? process.env.HERMES_URL);
  const apiKey = (config?.apiKey ?? process.env.HERMES_API_KEY ?? "").trim();
  const model =
    (config?.model ?? process.env.HERMES_MODEL ?? "").trim() || DEFAULT_MODEL;
  const fetchImpl = config?.fetchImpl ?? globalThis.fetch;

  if (!url) {
    throw new Error(
      'BACKEND="hermes" requires HERMES_URL (e.g. http://hermes-agent.railway.internal:8642).',
    );
  }
  if (!apiKey) {
    throw new Error(
      'BACKEND="hermes" requires HERMES_API_KEY (== the Hermes service API_SERVER_KEY).',
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("HermesGateway requires a fetch implementation.");
  }

  return {
    backend: "hermes",
    async *runTurn(
      api: OpenClawPluginApi,
      _cfg: PluginConfig,
      input: GatewayTurnInput,
    ): AsyncGenerator<GatewayEvent, GatewayResult, void> {
      // Immediate ack so the Linear session shows life before the model speaks.
      yield { type: "thought", body: ACK_THOUGHT };

      const messages: Array<{ role: string; content: string }> = [];
      const system = input.extraSystemPrompt.trim();
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: input.prompt });

      const res = await fetchImpl(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ model, messages, stream: false }),
        signal: input.signal,
      });

      if (!res.ok) {
        throw new Error(
          `Hermes POST /v1/chat/completions failed: ${res.status} ${await safeText(res)}`,
        );
      }

      const raw = await res.json().catch(() => undefined);
      api.logger.debug?.(
        `hermes gateway: chat.completion received session=${input.sessionKey}`,
      );
      const reply = extractChatReply(raw).trim();
      yield { type: "completion", body: reply };
      return {
        backend: "hermes",
        ok: Boolean(reply),
        reply,
        raw,
      };
    },
  };
}

/**
 * Pulls the assistant reply from an OpenAI-compatible chat completion.
 *
 * `choices[0].message.content` is normally a string; some servers return an
 * array of content parts, so text parts are concatenated defensively.
 */
export function extractChatReply(result: unknown): string {
  const root = readObject(result);
  if (!root) return "";
  const firstChoice = readObject(readArray(root.choices)[0]);
  const message = readObject(firstChoice?.message);
  if (!message) return "";

  const directText = readString(message.content);
  if (directText) return directText;

  const parts = readArray(message.content);
  if (parts.length > 0) {
    const texts: string[] = [];
    for (const part of parts) {
      const item = readObject(part);
      const text = readString(item?.text);
      if (text) texts.push(text);
    }
    return texts.join("");
  }
  return "";
}

function normalizeBaseUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  return value.replace(/\/+$/, "");
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}
