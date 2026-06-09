import test from "node:test";
import assert from "node:assert/strict";

import { ThoughtThrottler } from "./throttle.js";

const MIN = 2500;

test("leading edge: the first thought emits immediately", () => {
  const t = new ThoughtThrottler();
  assert.deepEqual(t.push("reading file", 0), [{ body: "reading file", count: 1 }]);
});

test("minimum interval: a second thought inside the window does not emit", () => {
  const t = new ThoughtThrottler();
  t.push("a", 0);
  assert.deepEqual(t.push("b", 100), []); // 100ms < 2500ms
  assert.deepEqual(t.push("c", MIN - 1), []);
});

test("a thought past the window emits the held pending, then leads again", () => {
  const t = new ThoughtThrottler();
  assert.deepEqual(t.push("a", 0), [{ body: "a", count: 1 }]); // leading
  assert.deepEqual(t.push("b", 100), []); // pending = b
  // Next push past the window flushes pending b; c becomes the new pending.
  assert.deepEqual(t.push("c", MIN + 100), [{ body: "b", count: 1 }]);
  assert.deepEqual(t.flush(), [{ body: "c", count: 1 }]);
});

test("adjacent repeats coalesce into one thought with a count", () => {
  const t = new ThoughtThrottler();
  t.push("a", 0); // leading emit
  t.push("reading file", 100); // pending, count 1
  t.push("reading file", 150); // count 2
  t.push("reading file", 200); // count 3
  assert.deepEqual(t.flush(), [{ body: "reading file (×3)", count: 3 }]);
});

test("a burst of 20 events within 100ms emits at most one thought", () => {
  const t = new ThoughtThrottler();
  const emitted: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    for (const e of t.push(`event ${i}`, i * 5)) emitted.push(e.body); // 0..95ms
  }
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0], "event 0"); // leading edge
});

test("the final pending event is always flushed", () => {
  const t = new ThoughtThrottler();
  t.push("a", 0); // leading
  t.push("tail", 200); // held
  assert.deepEqual(t.flush(), [{ body: "tail", count: 1 }]);
});

test("flush is a no-op when nothing is pending", () => {
  const t = new ThoughtThrottler();
  t.push("a", 0);
  assert.deepEqual(t.flush(), []);
});

test("cancel drops the pending thought and silences further pushes", () => {
  const t = new ThoughtThrottler();
  t.push("a", 0);
  t.push("held", 100);
  t.cancel();
  assert.deepEqual(t.flush(), []);
  assert.deepEqual(t.push("after", MIN * 10), []);
});

test("blank thoughts are ignored", () => {
  const t = new ThoughtThrottler();
  assert.deepEqual(t.push("   ", 0), []);
  assert.deepEqual(t.push("", 100), []);
});

test("a different thought inside the window replaces the pending slot (last wins)", () => {
  const t = new ThoughtThrottler();
  t.push("a", 0); // leading
  t.push("b", 100); // pending b
  t.push("c", 200); // pending replaced with c
  assert.deepEqual(t.flush(), [{ body: "c", count: 1 }]);
});

test("respects a custom minimum interval", () => {
  const t = new ThoughtThrottler({ minIntervalMs: 1000 });
  assert.deepEqual(t.push("a", 0), [{ body: "a", count: 1 }]);
  assert.deepEqual(t.push("b", 500), []); // within 1000
  assert.deepEqual(t.push("c", 1000), [{ body: "b", count: 1 }]); // window elapsed
});
