import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";

import {
  createHermesGateway,
  extractResponseText,
  summarizeToolArgs,
  toolCallLabel,
} from "./hermes-gateway.js";
import type {
  GatewayEvent,
  GatewayResult,
  GatewayTurnInput,
} from "./gateway-types.js";
import type { OpenClawPluginApi, PluginConfig } from "../types.js";

interface CapturedRequest {
  authorization?: string;
  accept?: string;
  body?: any;
}

/** One SSE frame: `event:` line + a JSON `data:` line. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * In-process mock Hermes `api_server`: answers `POST /v1/responses` by
 * streaming the supplied SSE frames (or a non-2xx status for the error path).
 */
function startMockHermes(opts: {
  status?: number;
  frames?: string[];
  errorBody?: unknown;
}): Promise<{
  url: string;
  captured: CapturedRequest;
  close: () => Promise<void>;
}> {
  const captured: CapturedRequest = {};
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/responses") {
      captured.authorization = req.headers["authorization"] as string;
      captured.accept = req.headers["accept"] as string;
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        captured.body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        const status = opts.status ?? 200;
        if (status !== 200) {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(opts.errorBody ?? { error: "boom" }));
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        for (const f of opts.frames ?? []) res.write(f);
        res.end();
      });
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
        close: () => new Promise<void>((done) => server.close(() => done())),
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
    extraSystemPrompt: "You are @Hermes.",
    timeoutMs: 30_000,
    issue: {
      id: "issue-1",
      identifier: "BRIDGE-15",
      title: "Stream progress",
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

/** A scripted run: created → token deltas → completed. */
function textFrames(text: string, id = "resp_1"): string[] {
  return [
    frame("response.created", { response: { id } }),
    frame("response.output_text.delta", { delta: text.slice(0, 3) }),
    frame("response.output_text.delta", { delta: text.slice(3) }),
    frame("response.completed", {
      response: {
        id,
        output: [
          { type: "message", content: [{ type: "output_text", text }] },
        ],
      },
    }),
  ];
}

test("happy path: ack thought, streamed reply, final completion + continuationId", async () => {
  const mock = await startMockHermes({ frames: textFrames("Here is the summary.") });
  try {
    const gateway = createHermesGateway({ url: mock.url, apiKey: "secret-key" });
    const { events, result } = await drain(
      gateway.runTurn(fakeApi, fakeCfg, turnInput()),
    );

    assert.deepEqual(events[0], { type: "thought", body: "Working on it…" });
    assert.deepEqual(events.at(-1), {
      type: "completion",
      body: "Here is the summary.",
    });
    assert.equal(result.backend, "hermes");
    assert.equal(result.ok, true);
    assert.equal(result.reply, "Here is the summary.");
    assert.equal(result.continuationId, "resp_1");

    // Request shape: Bearer auth + streaming Responses-API body.
    assert.equal(mock.captured.authorization, "Bearer secret-key");
    assert.equal(mock.captured.accept, "text/event-stream");
    assert.equal(mock.captured.body.model, "hermes-agent");
    assert.equal(mock.captured.body.stream, true);
    assert.equal(mock.captured.body.store, true);
    assert.equal(mock.captured.body.input, "Summarize the issue.");
    assert.equal(mock.captured.body.instructions, "You are @Hermes.");
    assert.equal(mock.captured.body.previous_response_id, undefined);
  } finally {
    await mock.close();
  }
});

test("tool-progress items surface with their arguments, once per call", async () => {
  // added (no args yet) → done (args complete) must yield ONE thought carrying
  // the command, not a bare "Running terminal".
  const frames = [
    frame("response.created", { response: { id: "resp_2" } }),
    frame("response.output_item.added", {
      output_index: 0,
      item: { id: "fc_1", type: "function_call", name: "terminal" },
    }),
    frame("response.output_item.done", {
      output_index: 0,
      item: {
        id: "fc_1",
        type: "function_call",
        name: "terminal",
        arguments: JSON.stringify({ command: "ls ~" }),
      },
    }),
    frame("response.output_text.delta", { delta: "Done." }),
    frame("response.completed", { response: { id: "resp_2" } }),
  ];
  const mock = await startMockHermes({ frames });
  try {
    const gateway = createHermesGateway({ url: mock.url, apiKey: "k" });
    const { events, result } = await drain(
      gateway.runTurn(fakeApi, fakeCfg, turnInput()),
    );
    const thoughts = events
      .filter((e) => e.type === "thought")
      .map((e) => (e as { body: string }).body);
    assert.ok(
      thoughts.includes("Running terminal: ls ~"),
      JSON.stringify(thoughts),
    );
    // Exactly one tool thought for the one call (no added+done double-post).
    assert.equal(
      thoughts.filter((t) => t.startsWith("Running terminal")).length,
      1,
      JSON.stringify(thoughts),
    );
    assert.equal(result.reply, "Done.");
  } finally {
    await mock.close();
  }
});

test("streamed token deltas keep their whitespace (no per-chunk trim)", async () => {
  // Regression: each delta was run through a trimming reader, eating the spaces
  // between tokens ("на Railway" → "наRailway").
  const frames = [
    frame("response.created", { response: { id: "resp_ws" } }),
    frame("response.output_text.delta", { delta: "Deploy on" }),
    frame("response.output_text.delta", { delta: " Railway" }),
    frame("response.output_text.delta", { delta: " now" }),
    frame("response.completed", { response: { id: "resp_ws" } }),
  ];
  const mock = await startMockHermes({ frames });
  try {
    const gateway = createHermesGateway({ url: mock.url, apiKey: "k" });
    const { result } = await drain(
      gateway.runTurn(fakeApi, fakeCfg, turnInput()),
    );
    assert.equal(result.reply, "Deploy on Railway now");
  } finally {
    await mock.close();
  }
});

test("hermes.tool.progress events also surface as thoughts", async () => {
  const frames = [
    frame("response.created", { response: { id: "resp_3" } }),
    frame("hermes.tool.progress", { tool: "grep", status: "running" }),
    frame("response.output_text.delta", { delta: "ok" }),
    frame("response.completed", { response: { id: "resp_3" } }),
  ];
  const mock = await startMockHermes({ frames });
  try {
    const gateway = createHermesGateway({ url: mock.url, apiKey: "k" });
    const { events } = await drain(
      gateway.runTurn(fakeApi, fakeCfg, turnInput()),
    );
    const thoughts = events
      .filter((e) => e.type === "thought")
      .map((e) => (e as { body: string }).body);
    assert.ok(thoughts.includes("Running grep"), JSON.stringify(thoughts));
  } finally {
    await mock.close();
  }
});

test("sends previous_response_id when a continuationId is supplied", async () => {
  const mock = await startMockHermes({ frames: textFrames("ok", "resp_next") });
  try {
    const gateway = createHermesGateway({ url: mock.url, apiKey: "k" });
    await drain(
      gateway.runTurn(
        fakeApi,
        fakeCfg,
        turnInput({ continuationId: "resp_prev" }),
      ),
    );
    assert.equal(mock.captured.body.previous_response_id, "resp_prev");
  } finally {
    await mock.close();
  }
});

test("omits instructions when extraSystemPrompt is empty", async () => {
  const mock = await startMockHermes({ frames: textFrames("ok") });
  try {
    const gateway = createHermesGateway({ url: mock.url, apiKey: "k" });
    await drain(
      gateway.runTurn(fakeApi, fakeCfg, turnInput({ extraSystemPrompt: "" })),
    );
    assert.equal(mock.captured.body.instructions, undefined);
  } finally {
    await mock.close();
  }
});

test("falls back to the completed response object when no deltas arrive", async () => {
  const frames = [
    frame("response.created", { response: { id: "resp_4" } }),
    frame("response.completed", {
      response: {
        id: "resp_4",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "whole answer" }],
          },
        ],
      },
    }),
  ];
  const mock = await startMockHermes({ frames });
  try {
    const gateway = createHermesGateway({ url: mock.url, apiKey: "k" });
    const { result } = await drain(
      gateway.runTurn(fakeApi, fakeCfg, turnInput()),
    );
    assert.equal(result.reply, "whole answer");
  } finally {
    await mock.close();
  }
});

test("a non-2xx response aborts the turn", async () => {
  const mock = await startMockHermes({ status: 500, errorBody: { error: "boom" } });
  try {
    const gateway = createHermesGateway({ url: mock.url, apiKey: "k" });
    await assert.rejects(
      drain(gateway.runTurn(fakeApi, fakeCfg, turnInput())),
      /v1\/responses failed: 500/,
    );
  } finally {
    await mock.close();
  }
});

test("a response.failed event surfaces as a thrown error", async () => {
  const frames = [
    frame("response.created", { response: { id: "resp_5" } }),
    frame("response.failed", {
      response: { id: "resp_5", error: { message: "model exploded" } },
    }),
  ];
  const mock = await startMockHermes({ frames });
  try {
    const gateway = createHermesGateway({ url: mock.url, apiKey: "k" });
    await assert.rejects(
      drain(gateway.runTurn(fakeApi, fakeCfg, turnInput())),
      /model exploded/,
    );
  } finally {
    await mock.close();
  }
});

test("requires HERMES_URL and HERMES_API_KEY", () => {
  assert.throws(() => createHermesGateway({ url: "", apiKey: "k" }), /HERMES_URL/);
  assert.throws(
    () => createHermesGateway({ url: "http://x", apiKey: "" }),
    /HERMES_API_KEY/,
  );
});

test("toolCallLabel appends an argument summary and ignores non-tool items", () => {
  assert.equal(
    toolCallLabel({ type: "function_call", name: "search", arguments: "" }),
    "Running search",
  );
  assert.equal(
    toolCallLabel({
      type: "function_call",
      name: "terminal",
      arguments: JSON.stringify({ command: "npm test" }),
    }),
    "Running terminal: npm test",
  );
  assert.equal(toolCallLabel({ type: "function_call_output", name: "x" }), undefined);
  assert.equal(toolCallLabel({ type: "message" }), undefined);
  assert.equal(toolCallLabel(null), undefined);
});

test("summarizeToolArgs prefers descriptive keys, tolerates strings and junk", () => {
  assert.equal(summarizeToolArgs(JSON.stringify({ path: "src/x.ts" })), "src/x.ts");
  assert.equal(summarizeToolArgs(JSON.stringify({ query: "hello   world" })), "hello world");
  assert.equal(summarizeToolArgs({ command: "ls -la" }), "ls -la");
  assert.equal(summarizeToolArgs("raw string command"), "raw string command");
  assert.equal(summarizeToolArgs(JSON.stringify({ foo: 1 })), '{"foo":1}');
  assert.equal(summarizeToolArgs(""), undefined);
  assert.equal(summarizeToolArgs(undefined), undefined);
  // Long values are truncated with an ellipsis.
  const long = "x".repeat(300);
  const summary = summarizeToolArgs({ command: long }) ?? "";
  assert.ok(summary.length <= 160 && summary.endsWith("…"), `len=${summary.length}`);
});

test("extractResponseText reads output_text and the message output array", () => {
  assert.equal(extractResponseText({ output_text: "direct" }), "direct");
  assert.equal(
    extractResponseText({
      output: [
        { type: "message", content: [{ type: "output_text", text: "a" }] },
        { type: "message", content: [{ type: "output_text", text: "b" }] },
      ],
    }),
    "ab",
  );
  assert.equal(extractResponseText(null), "");
});
