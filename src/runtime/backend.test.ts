import test from "node:test";
import assert from "node:assert/strict";

import { createGateway, selectBackend } from "./backend.js";
import type { OpenClawPluginApi } from "../types.js";

const fakeApi = {
  logger: {},
  registerHttpRoute: () => undefined,
} as unknown as OpenClawPluginApi;

test("defaults to openclaw when BACKEND is unset or empty", () => {
  assert.equal(selectBackend({}), "openclaw");
  assert.equal(selectBackend({ BACKEND: "" }), "openclaw");
  assert.equal(selectBackend({ BACKEND: "  " }), "openclaw");
});

test("accepts known backends case-insensitively", () => {
  assert.equal(selectBackend({ BACKEND: "openclaw" }), "openclaw");
  assert.equal(selectBackend({ BACKEND: "HERMES" }), "hermes");
  assert.equal(selectBackend({ BACKEND: " Openclaw " }), "openclaw");
});

test("throws on an unknown BACKEND value", () => {
  assert.throws(
    () => selectBackend({ BACKEND: "gpt" }),
    /Unknown BACKEND "gpt"/,
  );
});

test("createGateway returns the openclaw gateway by default", () => {
  const gateway = createGateway(fakeApi, "openclaw");
  assert.equal(gateway.backend, "openclaw");
  assert.equal(typeof gateway.runTurn, "function");
});

test("createGateway returns the hermes gateway when configured", () => {
  const prevUrl = process.env.HERMES_URL;
  const prevKey = process.env.HERMES_API_KEY;
  process.env.HERMES_URL = "http://hermes.railway.internal:8000";
  process.env.HERMES_API_KEY = "test-key";
  try {
    const gateway = createGateway(fakeApi, "hermes");
    assert.equal(gateway.backend, "hermes");
    assert.equal(typeof gateway.runTurn, "function");
  } finally {
    restoreEnv("HERMES_URL", prevUrl);
    restoreEnv("HERMES_API_KEY", prevKey);
  }
});

test("createGateway fails fast for hermes without HERMES_URL", () => {
  const prevUrl = process.env.HERMES_URL;
  const prevKey = process.env.HERMES_API_KEY;
  delete process.env.HERMES_URL;
  process.env.HERMES_API_KEY = "test-key";
  try {
    assert.throws(() => createGateway(fakeApi, "hermes"), /HERMES_URL/);
  } finally {
    restoreEnv("HERMES_URL", prevUrl);
    restoreEnv("HERMES_API_KEY", prevKey);
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
