import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";

import { createHermesGateway } from "./hermes-gateway.js";
import type { GatewayEvent, GatewayResult, GatewayTurnInput } from "./gateway-types.js";
import type { OpenClawPluginApi, PluginConfig } from "../types.js";

interface CapturedRun {
  authorization?: string;
  sessionKey?: string;
  body?: unknown;
}

/**
 * Spins up an in-process mock Hermes `api_server`: answers `POST /v1/runs`
 * with a run id and streams the supplied SSE script on `GET .../events`.
 */
function startMockHermes(sseScript: string): Promise<{
  url: string;
  captured: CapturedRun;
  close: () => Promise<void>;
}> {
  const captured: CapturedRun = {};
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/runs") {
      captured.authorization = req.headers["authorization"] as string;
      captured.sessionKey = req.headers["x-hermes-session-key"] as string;
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        captured.body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ run_id: "run-123" }));
      });
      return;
    }
    if (req.method === "GET" && req.url === "/v1/runs/run-123/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.end(sseScript);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        captured,
        close: () =>
          new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

const fakeApi = { logger: {} } as unknown as OpenClawPluginApi;
const fakeCfg = {} as PluginConfig;

function turnInput(overrides?: Partial<GatewayTurnInput>): GatewayTurnInput {
  return {
    agentId: "main",
    sessionKey: "linear:session-abc",
    label: "test",
    prompt: "Summarize the issue.",
    idempotencyKey: "key-1",
    extraSystemPrompt: "",
    timeoutMs: 30_000,
    issue: {
      id: "issue-1",
      identifier: "BRIDGE-14",
      title: "Deploy skeleton",
      url: "https://linear.app/x",
    },
    ...overrides,
  };
}

async function drain(
  gen: AsyncGenerator<GatewayEvent, GatewayResult, void>,
): Promise<{ events: GatewayEvent[]; result: GatewayResult }> {
  const events: GatewayEvent[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

test("happy path: ack thought, accumulates deltas, final completion on completed", async () => {
  const sse =
    'event: text_delta\ndata: {"type":"text_delta","delta":"Hello"}\n\n' +
    'event: text_delta\ndata: {"type":"text_delta","delta":", world"}\n\n' +
    'event: completed\ndata: {"type":"completed"}\n\n';
  const mock = await startMockHermes(sse);
  try {
    const gateway = createHermesGateway({
      url: mock.url,
      apiKey: "secret-key",
    });
    const { events, result } = await drain(
      gateway.runTurn(fakeApi, fakeCfg, turnInput()),
    );

    assert.deepEqual(events[0], { type: "thought", body: "Working on it…" });
    assert.deepEqual(events.at(-1), {
      type: "completion",
      body: "Hello, world",
    });
    assert.equal(result.backend, "hermes");
    assert.equal(result.ok, true);
    assert.equal(result.reply, "Hello, world");

    // Request shape: Bearer auth, session header, body contract.
    assert.equal(mock.captured.authorization, "Bearer secret-key");
    assert.equal(mock.captured.sessionKey, "linear:session-abc");
    assert.deepEqual(mock.captured.body, {
      prompt: "Summarize the issue.",
      session_key: "linear:session-abc",
      metadata: { linear_issue_id: "issue-1" },
    });
  } finally {
    await mock.close();
  }
});

test("completed event carrying inline final text wins over deltas", async () => {
  const sse =
    'event: text_delta\ndata: {"type":"text_delta","delta":"partial"}\n\n' +
    'event: completed\ndata: {"type":"completed","text":"Final answer."}\n\n';
  const mock = await startMockHermes(sse);
  try {
    const gateway = createHermesGateway({ url: mock.url, apiKey: "k" });
    const { result } = await drain(
      gateway.runTurn(fakeApi, fakeCfg, turnInput()),
    );
    assert.equal(result.reply, "Final answer.");
    assert.equal(result.ok, true);
  } finally {
    await mock.close();
  }
});

test("an error event aborts the turn", async () => {
  const sse = 'event: error\ndata: {"type":"error","message":"boom"}\n\n';
  const mock = await startMockHermes(sse);
  try {
    const gateway = createHermesGateway({ url: mock.url, apiKey: "k" });
    await assert.rejects(
      drain(gateway.runTurn(fakeApi, fakeCfg, turnInput())),
      /boom/,
    );
  } finally {
    await mock.close();
  }
});

test("requires HERMES_URL and HERMES_API_KEY", () => {
  assert.throws(
    () => createHermesGateway({ url: "", apiKey: "k" }),
    /HERMES_URL/,
  );
  assert.throws(
    () => createHermesGateway({ url: "http://x", apiKey: "" }),
    /HERMES_API_KEY/,
  );
});
