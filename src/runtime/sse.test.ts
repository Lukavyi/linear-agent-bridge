import test from "node:test";
import assert from "node:assert/strict";

import { SseDecoder } from "./sse.js";

test("decodes a single event with an explicit type", () => {
  const d = new SseDecoder();
  const events = d.push("event: response.created\ndata: {\"id\":\"r1\"}\n\n");
  assert.deepEqual(events, [
    { event: "response.created", data: '{"id":"r1"}' },
  ]);
});

test("defaults the event name to message when omitted", () => {
  const d = new SseDecoder();
  assert.deepEqual(d.push("data: hello\n\n"), [
    { event: "message", data: "hello" },
  ]);
});

test("joins multiple data lines with a newline", () => {
  const d = new SseDecoder();
  assert.deepEqual(d.push("data: line1\ndata: line2\n\n"), [
    { event: "message", data: "line1\nline2" },
  ]);
});

test("buffers an event split across chunks", () => {
  const d = new SseDecoder();
  assert.deepEqual(d.push("event: response.output_text.delta\nda"), []);
  assert.deepEqual(d.push('ta: {"delta":"hi"}\n\n'), [
    { event: "response.output_text.delta", data: '{"delta":"hi"}' },
  ]);
});

test("emits multiple events from one chunk", () => {
  const d = new SseDecoder();
  const events = d.push("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
  assert.deepEqual(events, [
    { event: "a", data: "1" },
    { event: "b", data: "2" },
  ]);
});

test("ignores comment lines and tolerates CRLF", () => {
  const d = new SseDecoder();
  const events = d.push(": keep-alive\r\nevent: ping\r\ndata: ok\r\n\r\n");
  assert.deepEqual(events, [{ event: "ping", data: "ok" }]);
});

test("flush surfaces a trailing event with no blank-line terminator", () => {
  const d = new SseDecoder();
  assert.deepEqual(d.push("event: done\ndata: x\n"), []);
  assert.deepEqual(d.flush(), [{ event: "done", data: "x" }]);
});
