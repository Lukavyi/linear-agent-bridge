import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createLinearWebhook } from "./handler.js";
import { clearContinuationCache } from "./continuation-store.js";
import type { ActivityContent, OpenClawPluginApi } from "../types.js";

/**
 * End-to-end integration test (BRIDGE-19).
 *
 * Drives a mock Linear webhook through the REAL bridge handler
 * (`createLinearWebhook`) into a REAL in-process mock Hermes `api_server` that
 * emits scripted SSE, asserting the exact sequence of Linear activity posts.
 *
 * Only the network boundaries are stubbed — exactly the seam these tests should
 * pin: `globalThis.fetch` is intercepted for `api.linear.app` (to capture what
 * the bridge sends to Linear) while every other request (the Hermes call) hits
 * the real mock server over a real socket, so abort/cancel semantics are
 * exercised for real. Everything in between — backend selector, runtime handler
 * routing, the SSE decoder, the coalescer↔mapper interaction, the continuation
 * store, and the correlation-ID tracer — runs unmocked.
 */

const SECRET = "e2e-webhook-secret";

// ── SSE frame helpers (mirror hermes-gateway.test.ts) ───────────────────────

/** One SSE frame: `event:` line + a JSON `data:` line. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A `function_call` tool, streamed as added (no args) → done (args complete). */
function toolCall(id: string, name: string, args: object): string[] {
  return [
    frame("response.output_item.added", {
      output_index: 0,
      item: { id, type: "function_call", name },
    }),
    frame("response.output_item.done", {
      output_index: 0,
      item: { id, type: "function_call", name, arguments: JSON.stringify(args) },
    }),
  ];
}

/** A response that streams `text` in two deltas and completes with `id`. */
function textRun(id: string, text: string): string[] {
  return [
    frame("response.created", { response: { id } }),
    frame("response.output_text.delta", { delta: text.slice(0, 3) }),
    frame("response.output_text.delta", { delta: text.slice(3) }),
    frame("response.completed", {
      response: {
        id,
        output: [{ type: "message", content: [{ type: "output_text", text }] }],
      },
    }),
  ];
}

// ── Mock Hermes api_server ──────────────────────────────────────────────────

interface HermesPlan {
  status?: number;
  errorBody?: unknown;
  frames?: string[];
  /** Open the stream, emit `frames`, then HANG (never end) — only abort ends it. */
  hang?: boolean;
}

interface MockHermes {
  url: string;
  /** Parsed request bodies, in arrival order (for `previous_response_id` asserts). */
  bodies: Record<string, unknown>[];
  /** True once a client (aborted fetch) dropped an in-flight request. */
  sawClose: () => boolean;
  /** Resolves once the server has received at least `n` requests. */
  waitForRequestCount: (n: number) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * In-process mock Hermes: answers `POST /v1/responses`. `plan(n, body)` decides
 * the response for the n-th request (1-based) so multi-turn tests can vary it.
 */
function startMockHermes(
  plan: (requestCount: number, body: Record<string, unknown>) => HermesPlan,
): Promise<MockHermes> {
  const bodies: Record<string, unknown>[] = [];
  let requestCount = 0;
  let sawClose = false;
  const waiters: { n: number; resolve: () => void }[] = [];

  const checkWaiters = (): void => {
    for (const w of [...waiters]) {
      if (requestCount >= w.n) {
        w.resolve();
        waiters.splice(waiters.indexOf(w), 1);
      }
    }
  };

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/responses") {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("close", () => {
      if (!res.writableEnded) sawClose = true;
    });
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      bodies.push(body);
      requestCount += 1;
      checkWaiters();

      const p = plan(requestCount, body);
      const status = p.status ?? 200;
      if (status !== 200) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(p.errorBody ?? { error: "boom" }));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      for (const f of p.frames ?? []) res.write(f);
      if (!p.hang) res.end();
      // hang: intentionally never res.end() — the run can only end via abort.
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        bodies,
        sawClose: () => sawClose,
        waitForRequestCount: (n) =>
          new Promise<void>((r) => {
            waiters.push({ n, resolve: r });
            checkWaiters();
          }),
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

// ── Linear stub + bridge harness ────────────────────────────────────────────

interface LinearStub {
  /** Activity contents the bridge posted to Linear, in order. */
  activities: ActivityContent[];
  /** Resolves with the first activity (existing or future) matching `pred`. */
  waitForActivity: (pred: (a: ActivityContent) => boolean) => Promise<ActivityContent>;
}

interface Bridge {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  linear: LinearStub;
  logs: string[];
  restore: () => void;
}

/**
 * Wires the bridge for one test: sets BACKEND=hermes env, installs the
 * fetch interceptor (Linear → recorder, everything else → real fetch), and
 * builds the handler. `restore()` undoes the global mutations.
 */
function buildBridge(hermesUrl: string, extraConfig: Record<string, unknown>): Bridge {
  const envKeys = ["BACKEND", "HERMES_URL", "HERMES_API_KEY", "HERMES_MODEL"];
  const envSnap = new Map(envKeys.map((k) => [k, process.env[k]]));
  process.env.BACKEND = "hermes";
  process.env.HERMES_URL = hermesUrl;
  process.env.HERMES_API_KEY = "test-key";
  process.env.HERMES_MODEL = "hermes-agent";

  const activities: ActivityContent[] = [];
  const waiters: { pred: (a: ActivityContent) => boolean; resolve: (a: ActivityContent) => void }[] = [];
  const record = (content: ActivityContent): void => {
    activities.push(content);
    for (const w of [...waiters]) {
      if (w.pred(content)) {
        w.resolve(content);
        waiters.splice(waiters.indexOf(w), 1);
      }
    }
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: { body?: unknown }) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    if (url.includes("api.linear.app")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const variables = (body.variables ?? {}) as Record<string, unknown>;
      const input2 = variables.input as { content?: ActivityContent } | undefined;
      if (input2?.content) {
        record(input2.content);
        return Promise.resolve(
          jsonResponse({ data: { agentActivityCreate: { success: true, agentActivity: { id: `a_${activities.length}` } } } }),
        );
      }
      // Any other Linear call (activity history, etc.) → benign empty payload.
      return Promise.resolve(
        jsonResponse({ data: { agentSession: { activities: { edges: [] } } } }),
      );
    }
    return realFetch(input as Parameters<typeof fetch>[0], init as Parameters<typeof fetch>[1]);
  }) as typeof fetch;

  const logs: string[] = [];
  const api = {
    pluginConfig: {
      linearApiKey: "lin-key",
      linearWebhookSecret: SECRET,
      ...extraConfig,
    },
    logger: {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    },
    registerHttpRoute: () => {},
  } as unknown as OpenClawPluginApi;

  const handler = createLinearWebhook(api);

  return {
    handler,
    linear: {
      activities,
      waitForActivity: (pred) =>
        new Promise<ActivityContent>((resolve) => {
          const existing = activities.find(pred);
          if (existing) return resolve(existing);
          waiters.push({ pred, resolve });
        }),
    },
    logs,
    restore: () => {
      globalThis.fetch = realFetch;
      for (const [k, v] of envSnap) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Webhook driver ──────────────────────────────────────────────────────────

/** POSTs a signed webhook into the handler and awaits the immediate 202. */
async function postWebhook(
  bridge: Bridge,
  payload: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = createHmac("sha256", SECRET).update(raw).digest("hex");
  const req = Readable.from([raw]) as unknown as IncomingMessage & { headers: Record<string, string> };
  req.method = "POST";
  req.url = "/plugins/linear/linear";
  req.headers = {
    "content-type": "application/json",
    "linear-signature": signature,
    "linear-delivery": deliveryId,
  };

  let endResolve: () => void;
  const ended = new Promise<void>((r) => (endResolve = r));
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    end(chunk?: unknown) {
      if (chunk != null) this.body += String(chunk);
      endResolve();
    },
  };

  await bridge.handler(req, res as unknown as ServerResponse);
  await ended;
  assert.equal(res.statusCode, 202, `webhook should 202, got ${res.statusCode}`);
}

const sessionPayload = (
  sessionId: string,
  action: "created" | "prompted",
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: "AgentSessionEvent",
  action,
  agentSession: { id: sessionId },
  ...extra,
});

const tmpStore = (name: string): string =>
  path.join(os.tmpdir(), `bridge-e2e-${name}-${process.pid}.json`);

// ── Tests ───────────────────────────────────────────────────────────────────

test("happy path: created webhook → scripted SSE → exact Linear activity sequence + correlation trace", async () => {
  const mock = await startMockHermes(() => ({
    frames: [
      frame("response.created", { response: { id: "resp_h" } }),
      ...toolCall("fc1", "terminal", { command: "ls ~" }),
      ...toolCall("fc2", "read_file", { path: "a.ts" }),
      frame("response.output_text.delta", { delta: "All " }),
      frame("response.output_text.delta", { delta: "done." }),
      frame("response.completed", {
        response: {
          id: "resp_h",
          output: [{ type: "message", content: [{ type: "output_text", text: "All done." }] }],
        },
      }),
    ],
  }));
  const bridge = buildBridge(mock.url, { hermesContinuationStorePath: tmpStore("happy") });
  const session = "sess-happy";
  const delivery = "delivery-happy-1";
  try {
    await postWebhook(bridge, sessionPayload(session, "created"), delivery);
    await bridge.linear.waitForActivity((a) => a.type === "response");

    assert.deepEqual(bridge.linear.activities, [
      { type: "thought", body: "Received the Linear session. Thinking now." },
      { type: "thought", body: "Working on it…" },
      { type: "thought", body: "Running terminal: ls ~" },
      { type: "thought", body: "Running read_file: a.ts" },
      { type: "response", body: "All done." },
    ]);

    // The Hermes request carried the streaming Responses-API shape, no resume id.
    assert.equal(mock.bodies[0].stream, true);
    assert.equal(mock.bodies[0].previous_response_id, undefined);

    // Correlation-ID tracer: one cid (the linear-delivery header) consistent
    // across the webhook's logged phases. `turn_completed` is logged just after
    // the terminal activity posts, so wait for it before asserting the trace.
    const cidOf = (phase: string): string | undefined =>
      bridge.logs
        .filter((l) => l.includes("cid="))
        .find((l) => l.includes(`phase=${phase}`))
        ?.match(/cid=(\S+)/)?.[1];
    for (let i = 0; i < 50 && cidOf("turn_completed") === undefined; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    for (const phase of ["webhook_received", "signature_verified", "turn_started", "turn_completed"]) {
      assert.equal(cidOf(phase), delivery, `phase ${phase} should carry cid=${delivery}`);
    }
  } finally {
    bridge.restore();
    await mock.close();
  }
});

test("error path: a non-2xx Hermes response yields a terminal error activity", async () => {
  const mock = await startMockHermes(() => ({ status: 500, errorBody: { error: "kaboom" } }));
  const bridge = buildBridge(mock.url, { hermesContinuationStorePath: tmpStore("error") });
  try {
    await postWebhook(bridge, sessionPayload("sess-error", "created"), "delivery-error-1");
    const err = await bridge.linear.waitForActivity((a) => a.type === "error");

    assert.equal(err.type, "error");
    assert.match(err.body ?? "", /Agent run failed/);
    assert.match(err.body ?? "", /500/);
    // No final response was posted for a failed run.
    assert.equal(bridge.linear.activities.some((a) => a.type === "response"), false);

    const traced = bridge.logs.filter((l) => l.includes("cid=delivery-error-1"));
    assert.ok(
      traced.some((l) => l.includes("phase=turn_errored")),
      "a failed turn should log turn_errored under the same cid",
    );
  } finally {
    bridge.restore();
    await mock.close();
  }
});

test("cancel path: a stop signal aborts the in-flight Hermes request and posts no run output", async () => {
  // First request opens the stream then hangs; only an abort can end it.
  const mock = await startMockHermes(() => ({
    frames: [frame("response.created", { response: { id: "resp_cancel" } })],
    hang: true,
  }));
  const bridge = buildBridge(mock.url, { hermesContinuationStorePath: tmpStore("cancel") });
  const session = "sess-cancel";
  try {
    await postWebhook(bridge, sessionPayload(session, "created"), "delivery-cancel-start");
    // Wait until the bridge's Hermes request is in-flight, then cancel.
    await mock.waitForRequestCount(1);
    await new Promise((r) => setTimeout(r, 50));

    await postWebhook(
      bridge,
      sessionPayload(session, "prompted", { signal: "stop" }),
      "delivery-cancel-stop",
    );

    // handleStopSignal posts a single stop-acknowledgement `response`.
    const stop = await bridge.linear.waitForActivity(
      (a) => a.type === "response" && /Stop request received/.test(a.body ?? ""),
    );
    assert.ok(stop);

    // Give the abort time to propagate to the server socket.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(mock.sawClose(), true, "aborted fetch should drop the server connection");

    // The aborted run produced no completion and no error activity — only the
    // ack thoughts and the stop acknowledgement.
    assert.equal(
      bridge.linear.activities.some((a) => a.type === "error"),
      false,
      "a stopped run must not post an error",
    );
    const responses = bridge.linear.activities.filter((a) => a.type === "response");
    assert.equal(responses.length, 1, "only the stop acknowledgement should post");
  } finally {
    bridge.restore();
    await mock.close();
  }
});

test("session continuity: a follow-up replays the prior turn's response id", async () => {
  const mock = await startMockHermes((n) =>
    n === 1
      ? { frames: textRun("resp_one", "First.") }
      : { frames: textRun("resp_two", "Second.") },
  );
  const storePath = tmpStore("continuity");
  clearContinuationCache(storePath);
  const bridge = buildBridge(mock.url, { hermesContinuationStorePath: storePath });
  const session = "sess-continuity";
  try {
    await postWebhook(bridge, sessionPayload(session, "created"), "delivery-cont-1");
    await bridge.linear.waitForActivity((a) => a.type === "response" && a.body === "First.");

    await postWebhook(
      bridge,
      sessionPayload(session, "prompted", { agentActivity: { id: "act-2", body: "And then?" } }),
      "delivery-cont-2",
    );
    await bridge.linear.waitForActivity((a) => a.type === "response" && a.body === "Second.");

    assert.equal(mock.bodies.length, 2);
    assert.equal(mock.bodies[0].previous_response_id, undefined, "first turn starts fresh");
    assert.equal(
      mock.bodies[1].previous_response_id,
      "resp_one",
      "follow-up resumes the first turn's response id",
    );
  } finally {
    bridge.restore();
    clearContinuationCache(storePath);
    await mock.close();
  }
});
