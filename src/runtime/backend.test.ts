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

test("createGateway fails fast for the not-yet-implemented hermes backend", () => {
  assert.throws(
    () => createGateway(fakeApi, "hermes"),
    /Hermes gateway is not implemented/,
  );
});
