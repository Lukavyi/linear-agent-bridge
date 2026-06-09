import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";

import { createHermesGateway, extractChatReply } from "./hermes-gateway.js";
import type {
  GatewayEvent,
  GatewayResult,
  GatewayTurnInput,
} from "./gateway-types.js";
import type { OpenClawPluginApi, PluginConfig } from "../types.js";

interface CapturedRequest {
  authorization?: string;
  contentType?: string;
  body?: any;
}

/**
 * In-process mock Hermes `api_server`: answers `POST /v1/chat/completions`
 * with the supplied response object (or a status for the error path).
 */
function startMockHermes(opts: {
  status?: number;
  response?: unknown;
}): Promise<{
  url: string;
  captured: CapturedRequest;
  close: () => Promise<void>;
}> {
  const captured: CapturedRequest = {};
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      captured.authorization = req.headers["authorization"] as string;
      captured.contentType = req.headers["content-type"] as string;
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        captured.body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        const status = opts.status ?? 200;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(opts.response ?? { error: "boom" }));
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

function completion(content: string): unknown {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}

test("happy path: ack thought then final completion from chat.completion", async () => {
  const mock = await startMockHermes({ response: completion("Here is the summary.") });
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

    // Request shape: Bearer auth + OpenAI chat body with system + user turns.
    assert.equal(mock.captured.authorization, "Bearer secret-key");
    assert.equal(mock.captured.body.model, "hermes-agent");
    assert.equal(mock.captured.body.stream, false);
    assert.deepEqual(mock.captured.body.messages, [
      { role: "system", content: "You are @Hermes." },
      { role: "user", content: "Summarize the issue." },
    ]);
  } finally {
    await mock.close();
  }
});

test("omits the system message when extraSystemPrompt is empty", async () => {
  const mock = await startMockHermes({ response: completion("ok") });
  try {
    const gateway = createHermesGateway({ url: mock.url, apiKey: "k" });
    await drain(
      gateway.runTurn(fakeApi, fakeCfg, turnInput({ extraSystemPrompt: "" })),
    );
    assert.deepEqual(mock.captured.body.messages, [
      { role: "user", content: "Summarize the issue." },
    ]);
  } finally {
    await mock.close();
  }
});

test("uses a configurable model name", async () => {
  const mock = await startMockHermes({ response: completion("ok") });
  try {
    const gateway = createHermesGateway({
      url: mock.url,
      apiKey: "k",
      model: "hermes-4",
    });
    await drain(gateway.runTurn(fakeApi, fakeCfg, turnInput()));
    assert.equal(mock.captured.body.model, "hermes-4");
  } finally {
    await mock.close();
  }
});

test("a non-2xx response aborts the turn", async () => {
  const mock = await startMockHermes({ status: 500, response: { error: "boom" } });
  try {
    const gateway = createHermesGateway({ url: mock.url, apiKey: "k" });
    await assert.rejects(
      drain(gateway.runTurn(fakeApi, fakeCfg, turnInput())),
      /chat\/completions failed: 500/,
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

test("extractChatReply joins array content parts and tolerates junk", () => {
  assert.equal(extractChatReply(completion("plain")), "plain");
  assert.equal(
    extractChatReply({
      choices: [
        {
          message: {
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        },
      ],
    }),
    "ab",
  );
  assert.equal(extractChatReply(null), "");
  assert.equal(extractChatReply({ choices: [] }), "");
});
