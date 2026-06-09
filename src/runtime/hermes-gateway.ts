import type { OpenClawPluginApi, PluginConfig } from "../types.js";
import { readObject, readString } from "../util.js";
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
 * `http://hermes.railway.internal:8000`); `apiKey` is the Hermes
 * `API_SERVER_KEY`. `fetchImpl` is injectable so tests can run against an
 * in-process mock SSE server.
 */
export interface HermesGatewayConfig {
  url: string;
  apiKey: string;
  fetchImpl: typeof fetch;
}

const ACK_THOUGHT = "Working on it…";

/**
 * Minimal `HermesGateway` — the walking-skeleton backend for @Hermes.
 *
 * One turn = `POST /v1/runs` (Bearer auth + `X-Hermes-Session-Key` for session
 * continuity), an immediate ack `thought`, then a subscription to the run's SSE
 * event stream. On the terminal `completed` event it emits a single
 * `completion` carrying the final reply; an `error` event aborts the turn.
 *
 * Deliberately omits throttling, intermediate progress streaming,
 * cancellation, and rich error mapping — those are follow-up slices
 * (see BRIDGE-12). Intermediate events are accumulated only to recover the
 * final text when `completed` does not carry it inline.
 */
export function createHermesGateway(
  config?: Partial<HermesGatewayConfig>,
): Gateway {
  const url = normalizeBaseUrl(config?.url ?? process.env.HERMES_URL);
  const apiKey = (config?.apiKey ?? process.env.HERMES_API_KEY ?? "").trim();
  const fetchImpl = config?.fetchImpl ?? globalThis.fetch;

  if (!url) {
    throw new Error(
      'BACKEND="hermes" requires HERMES_URL (e.g. http://hermes.railway.internal:port).',
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
      const runId = await startRun(fetchImpl, url, apiKey, input);
      api.logger.info?.(
        `hermes gateway: started run ${runId} session=${input.sessionKey}`,
      );

      // Immediate ack so the Linear session shows life before the model speaks.
      yield { type: "thought", body: ACK_THOUGHT };

      let accumulated = "";
      let finalReply: string | undefined;
      let lastEvent: unknown;

      for await (const sse of streamRunEvents(
        fetchImpl,
        url,
        apiKey,
        runId,
        input.signal,
      )) {
        const data = parseEventData(sse.data);
        lastEvent = data ?? sse.data;
        const type = resolveEventType(sse.event, data);

        switch (type) {
          case "text_delta":
          case "token":
          case "delta": {
            accumulated += extractDelta(data);
            break;
          }
          case "completed":
          case "complete":
          case "done": {
            finalReply = extractFinalText(data) ?? accumulated;
            break;
          }
          case "error":
          case "failed": {
            throw new Error(extractErrorMessage(data));
          }
          default: {
            // Progress / tool_call / unknown — ignored in the skeleton, but
            // logged so the live event taxonomy can be reverse-engineered.
            api.logger.debug?.(
              `hermes gateway: ignoring event type=${type ?? "<none>"}`,
            );
          }
        }

        if (finalReply !== undefined) break;
      }

      const reply = (finalReply ?? accumulated).trim();
      yield { type: "completion", body: reply };
      return {
        backend: "hermes",
        ok: Boolean(reply),
        reply,
        raw: lastEvent,
      };
    },
  };
}

/** Starts a Hermes run and returns its `run_id`. */
async function startRun(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  input: GatewayTurnInput,
): Promise<string> {
  const metadata: Record<string, string> = {};
  if (input.issue?.id) metadata.linear_issue_id = input.issue.id;

  const res = await fetchImpl(`${url}/v1/runs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Hermes-Session-Key": input.sessionKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      prompt: input.prompt,
      session_key: input.sessionKey,
      metadata,
    }),
    signal: input.signal,
  });

  if (!res.ok) {
    throw new Error(
      `Hermes POST /v1/runs failed: ${res.status} ${await safeText(res)}`,
    );
  }

  const body = readObject(await res.json().catch(() => undefined));
  const runId = readString(body?.run_id) ?? readString(body?.id);
  if (!runId) {
    throw new Error("Hermes POST /v1/runs returned no run_id.");
  }
  return runId;
}

/** Opens the run's SSE stream and yields parsed `{ event, data }` blocks. */
async function* streamRunEvents(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  runId: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<{ event?: string; data: string }> {
  const res = await fetchImpl(
    `${url}/v1/runs/${encodeURIComponent(runId)}/events`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
      },
      signal,
    },
  );

  if (!res.ok || !res.body) {
    throw new Error(
      `Hermes GET /v1/runs/${runId}/events failed: ${res.status} ${await safeText(res)}`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line. Normalize CRLF first.
      let sep: number;
      buffer = buffer.replace(/\r\n/g, "\n");
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseSseBlock(block);
        if (parsed) yield parsed;
      }
    }
    const tail = parseSseBlock(buffer.replace(/\r\n/g, "\n"));
    if (tail) yield tail;
  } finally {
    reader.releaseLock?.();
  }
}

/** Parses one SSE block into its `event:` name and joined `data:` payload. */
function parseSseBlock(
  block: string,
): { event?: string; data: string } | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0 && event === undefined) return null;
  return { event, data: dataLines.join("\n") };
}

function parseEventData(data: string): Record<string, unknown> | undefined {
  const trimmed = data.trim();
  if (!trimmed) return undefined;
  try {
    return readObject(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function resolveEventType(
  sseEvent: string | undefined,
  data: Record<string, unknown> | undefined,
): string | undefined {
  return (
    readString(data?.type)?.toLowerCase() ??
    readString(data?.event)?.toLowerCase() ??
    sseEvent?.toLowerCase()
  );
}

function extractDelta(data: Record<string, unknown> | undefined): string {
  return (
    readString(data?.delta) ??
    readString(data?.text) ??
    readString(data?.content) ??
    ""
  );
}

function extractFinalText(
  data: Record<string, unknown> | undefined,
): string | undefined {
  if (!data) return undefined;
  const nested = readObject(data.result) ?? readObject(data.response);
  return (
    readString(data.text) ??
    readString(data.output) ??
    readString(data.content) ??
    readString(data.message) ??
    readString(data.reply) ??
    readString(nested?.text) ??
    readString(nested?.content) ??
    readString(nested?.output)
  );
}

function extractErrorMessage(
  data: Record<string, unknown> | undefined,
): string {
  return (
    readString(data?.message) ??
    readString(data?.error) ??
    readString(readObject(data?.error)?.message) ??
    "Hermes run reported an error."
  );
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
