import test from "node:test";
import assert from "node:assert/strict";

import {
  NO_REPLY_MESSAGE,
  mapGatewayEventToActivity,
} from "./event-mapper.js";

test("maps a non-empty completion to a response activity", () => {
  assert.deepEqual(
    mapGatewayEventToActivity({ type: "completion", body: "  done  " }),
    { type: "response", body: "done" },
  );
});

test("maps an empty completion to the no-reply error activity", () => {
  assert.deepEqual(
    mapGatewayEventToActivity({ type: "completion", body: "   " }),
    { type: "error", body: NO_REPLY_MESSAGE },
  );
});

test("maps a thought to a thought activity and drops empty ones", () => {
  assert.deepEqual(
    mapGatewayEventToActivity({ type: "thought", body: "thinking" }),
    { type: "thought", body: "thinking" },
  );
  assert.equal(
    mapGatewayEventToActivity({ type: "thought", body: "  " }),
    null,
  );
});

test("maps an action with optional parameter and result", () => {
  assert.deepEqual(
    mapGatewayEventToActivity({
      type: "action",
      action: "run",
      parameter: "ls",
      result: "ok",
    }),
    { type: "action", action: "run", parameter: "ls", result: "ok" },
  );
  assert.deepEqual(
    mapGatewayEventToActivity({ type: "action", action: "run" }),
    { type: "action", action: "run" },
  );
  assert.equal(
    mapGatewayEventToActivity({ type: "action", action: "  " }),
    null,
  );
});
