import type { OpenClawPluginApi, PluginConfig } from "../types.js";
import { readArray, readObject, readString } from "../util.js";
import type {
  Gateway,
  GatewayEvent,
  GatewayResult,
  GatewayTurnInput,
} from "./gateway-types.js";
import { SseDecoder, type SseEvent } from "./sse.js";
import { ThoughtThrottler } from "./throttle.js";

/**
 * Resolved connection settings for the Hermes `api_server`.
 *
 * `url` points at the private Railway service (e.g.
 * `http://hermes-agent.railway.internal:8642`); `apiKey` is the Hermes
 * `API_SERVER_KEY`. `model` is the OpenAI-compatible model name Hermes expects
 * (default `hermes-agent`). `fetchImpl` is injectable so tests can run against
 * an in-process mock server. `now` is injectable so the throttler's timing is
 * deterministic under test.
 */
export interface HermesGatewayConfig {
  url: string;
  apiKey: string;
  model: string;
  fetchImpl: typeof fetch;
  now: () => number;
}

const ACK_THOUGHT = "Working on it…";
const DEFAULT_MODEL = "hermes-agent";

/**
 * `HermesGateway` — the @Hermes backend, talking to Hermes' OpenAI-compatible
 * `api_server` over the Responses API.
 *
 * One turn is a single streaming `POST /v1/responses` (Bearer auth, `stream:
 * true`). The gateway:
 *
 *   - emits an immediate ack `thought` so the Linear session shows life;
 *   - surfaces tool-progress signals (`response.output_item.*` carrying
 *     `function_call` items, plus Hermes' custom `hermes.tool.progress`) as
 *     intermediate `thought`s, run through a {@link ThoughtThrottler} so a burst
 *     of tool calls can't flood Linear's feed;
 *   - accumulates assistant token deltas (`response.output_text.delta`) into the
 *     final visible reply, emitted as one terminal `completion`.
 *
 * The Responses API stores conversation state server-side. The terminal
 * `response.id` is returned as `GatewayResult.continuationId`; passing it back
 * as `GatewayTurnInput.continuationId` (`previous_response_id`) resumes the same
 * conversation on the next turn.
 */
export function createHermesGateway(
  config?: Partial<HermesGatewayConfig>,
): Gateway {
  const url = normalizeBaseUrl(config?.url ?? process.env.HERMES_URL);
  const apiKey = (config?.apiKey ?? process.env.HERMES_API_KEY ?? "").trim();
  const model =
    (config?.model ?? process.env.HERMES_MODEL ?? "").trim() || DEFAULT_MODEL;
  const fetchImpl = config?.fetchImpl ?? globalThis.fetch;
  const now = config?.now ?? Date.now;

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

      const requestBody: Record<string, unknown> = {
        model,
        input: input.prompt,
        stream: true,
        store: true,
      };
      const system = input.extraSystemPrompt.trim();
      if (system) requestBody.instructions = system;
      // Resume the server-side conversation when the runtime hands us a prior id.
      if (input.continuationId) {
        requestBody.previous_response_id = input.continuationId;
      }

      const res = await fetchImpl(`${url}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(requestBody),
        signal: input.signal,
      });

      if (!res.ok) {
        throw new Error(
          `Hermes POST /v1/responses failed: ${res.status} ${await safeText(res)}`,
        );
      }
      if (!res.body) {
        throw new Error("Hermes POST /v1/responses returned no response body.");
      }

      const throttler = new ThoughtThrottler();
      const decoder = new SseDecoder();
      const textDecoder = new TextDecoder();
      const reader = res.body.getReader();
      let replyBuf = "";
      let responseId: string | undefined;
      let lastResponseObject: unknown;
      let streamError: string | undefined;
      // Tool items stream as added → arguments → done; emit one thought per call.
      const emittedTools = new Set<string>();

      const handle = function* (sse: SseEvent): Generator<GatewayEvent> {
        const data = parseEventData(sse.data);
        switch (sse.event) {
          case "response.created":
          case "response.in_progress":
          case "response.completed":
          case "response.failed":
          case "response.incomplete": {
            const responseObj = readObject(readObject(data)?.response);
            const id = readString(responseObj?.id);
            if (id) responseId = id;
            if (responseObj) lastResponseObject = responseObj;
            if (sse.event === "response.failed") {
              streamError =
                readString(readObject(responseObj?.error)?.message) ??
                "Hermes reported response.failed";
            }
            return;
          }
          case "response.output_text.delta": {
            // Append the delta VERBATIM — trimming each chunk would swallow the
            // spaces between streamed tokens ("на Railway" → "наRailway").
            const delta = readRawString(readObject(data)?.delta);
            if (delta) replyBuf += delta;
            return;
          }
          case "response.output_item.added":
          case "response.output_item.done": {
            const dataObj = readObject(data);
            const item = readObject(dataObj?.item);
            if (!item || readString(item.type) !== "function_call") return;
            const key = toolItemKey(item, dataObj);
            if (emittedTools.has(key)) return;
            // Arguments arrive after `added`; wait for them so the thought shows
            // the actual command, not a bare "Running terminal".
            if (sse.event === "response.output_item.added" && !toolArgsPresent(item)) {
              return;
            }
            emittedTools.add(key);
            const label = toolCallLabel(item);
            if (label) yield* emitThoughts(throttler.push(label, now()));
            return;
          }
          case "hermes.tool.progress": {
            const label = hermesToolProgressLabel(data);
            if (label) yield* emitThoughts(throttler.push(label, now()));
            return;
          }
          case "error":
          case "response.error": {
            streamError =
              readString(readObject(data)?.message) ??
              (typeof sse.data === "string" ? sse.data : "Hermes stream error");
            return;
          }
          default:
            // Unknown event types are ignored (logged at debug, not fatal).
            api.logger.debug?.(`hermes gateway: ignored SSE event=${sse.event}`);
            return;
        }
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = textDecoder.decode(value, { stream: true });
          for (const sse of decoder.push(chunk)) yield* handle(sse);
        }
        for (const sse of decoder.flush()) yield* handle(sse);
      } finally {
        reader.releaseLock?.();
      }

      // Flush any thought held inside the throttle window.
      yield* emitThoughts(throttler.flush());

      if (streamError) {
        throw new Error(`Hermes stream error: ${streamError}`);
      }

      const reply = (replyBuf || extractResponseText(lastResponseObject)).trim();
      api.logger.debug?.(
        `hermes gateway: response complete session=${input.sessionKey} response_id=${responseId ?? "n/a"}`,
      );
      yield { type: "completion", body: reply };
      return {
        backend: "hermes",
        ok: Boolean(reply),
        reply,
        raw: lastResponseObject,
        continuationId: responseId,
      };
    },
  };
}

function* emitThoughts(emits: { body: string }[]): Generator<GatewayEvent> {
  for (const emit of emits) {
    yield { type: "thought", body: emit.body };
  }
}

/** Max characters of an argument summary surfaced in a progress thought. */
const ARG_SUMMARY_LIMIT = 160;
// Argument keys, in priority order, that best describe what a tool call is doing.
const ARG_SUMMARY_KEYS = [
  "command",
  "cmd",
  "script",
  "path",
  "file",
  "file_path",
  "filepath",
  "query",
  "q",
  "url",
  "pattern",
  "expression",
  "code",
  "input",
];

/**
 * Human-readable label for a `function_call` output item, including a short
 * summary of its arguments so the thought reads "Running terminal: npm test"
 * rather than a bare "Running terminal". Returns `undefined` for non-tool items.
 */
export function toolCallLabel(item: unknown): string | undefined {
  const obj = readObject(item);
  if (!obj || readString(obj.type) !== "function_call") return undefined;
  const name = readString(obj.name) ?? "tool";
  const summary = summarizeToolArgs(obj.arguments);
  return summary ? `Running ${name}: ${summary}` : `Running ${name}`;
}

/** True once a `function_call` item carries non-empty arguments. */
export function toolArgsPresent(item: Record<string, unknown>): boolean {
  const parsed = parseToolArgs(item.arguments);
  if (parsed === undefined) return false;
  if (typeof parsed === "string") return parsed.trim().length > 0;
  return Object.keys(parsed).length > 0;
}

/** A short, single-line summary of a tool call's arguments. */
export function summarizeToolArgs(raw: unknown): string | undefined {
  const parsed = parseToolArgs(raw);
  if (parsed === undefined) return undefined;
  if (typeof parsed === "string") return truncate(collapse(parsed));

  for (const key of ARG_SUMMARY_KEYS) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim()) {
      return truncate(collapse(value));
    }
  }
  const keys = Object.keys(parsed);
  if (keys.length === 0) return undefined;
  try {
    return truncate(collapse(JSON.stringify(parsed)));
  } catch {
    return undefined;
  }
}

/** Arguments may arrive as a JSON string or an already-parsed object. */
function parseToolArgs(
  raw: unknown,
): string | Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    try {
      const parsed = JSON.parse(trimmed);
      const obj = readObject(parsed);
      return obj ?? trimmed;
    } catch {
      return trimmed;
    }
  }
  return readObject(raw);
}

/** Stable per-call key so a tool call emits exactly one thought. */
function toolItemKey(
  item: Record<string, unknown>,
  data: Record<string, unknown> | undefined,
): string {
  return (
    readString(item.id) ??
    readString(item.call_id) ??
    `idx:${readString(data?.output_index) ?? String(data?.output_index ?? item.name ?? "0")}`
  );
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string): string {
  return value.length > ARG_SUMMARY_LIMIT
    ? `${value.slice(0, ARG_SUMMARY_LIMIT - 1)}…`
    : value;
}

/** Label for Hermes' custom `hermes.tool.progress` SSE event. */
export function hermesToolProgressLabel(data: unknown): string | undefined {
  const obj = readObject(data);
  if (!obj) return undefined;
  const name =
    readString(obj.tool) ?? readString(obj.name) ?? readString(obj.tool_name);
  const status = readString(obj.status);
  if (!name) return status ? `Working: ${status}` : undefined;
  return status ? `${capitalize(status)} ${name}` : `Running ${name}`;
}

/**
 * Pulls assistant text from a terminal Responses-API `response` object. Used as
 * a fallback when no `output_text.delta` events were seen (non-streaming
 * servers, or a response delivered whole on `response.completed`).
 */
export function extractResponseText(response: unknown): string {
  const root = readObject(response);
  if (!root) return "";

  // Read text verbatim (no per-part trim) so spacing across parts is preserved;
  // the caller trims the assembled whole.
  const direct = readRawString(root.output_text);
  if (direct) return direct;

  const texts: string[] = [];
  for (const item of readArray(root.output)) {
    const itemObj = readObject(item);
    if (readString(itemObj?.type) !== "message") continue;
    for (const part of readArray(itemObj?.content)) {
      const partObj = readObject(part);
      const type = readString(partObj?.type);
      if (type === "output_text" || type === "text") {
        const text = readRawString(partObj?.text);
        if (text) texts.push(text);
      }
    }
  }
  return texts.join("");
}

/** Like `readString` but WITHOUT trimming — for streamed text where edge
 * whitespace is significant. Empty strings still read as undefined. */
function readRawString(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined;
}

function parseEventData(data: string): unknown {
  if (!data) return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
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
