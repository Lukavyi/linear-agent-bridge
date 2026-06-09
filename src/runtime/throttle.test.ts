import test from "node:test";
import assert from "node:assert/strict";

import { ThoughtThrottler } from "./throttle.js";

function drain(t: ThoughtThrottler, bodies: string[]): string[] {
  const out: string[] = [];
  for (const b of bodies) for (const e of t.push(b)) out.push(e.body);
  for (const e of t.flush()) out.push(e.body);
  return out;
}

test("every distinct command is emitted, in order", () => {
  const t = new ThoughtThrottler();
  assert.deepEqual(drain(t, ["ls ~", "pwd", "cat a", "grep x"]), [
    "ls ~",
    "pwd",
    "cat a",
    "grep x",
  ]);
});

test("a duplicate is the exact same command back-to-back — those coalesce with a count", () => {
  const t = new ThoughtThrottler();
  assert.deepEqual(drain(t, ["reading file", "reading file", "reading file"]), [
    "reading file (×3)",
  ]);
});

test("different args are NOT duplicates (ls ~ then ls / both show)", () => {
  const t = new ThoughtThrottler();
  assert.deepEqual(drain(t, ["Running terminal: ls ~", "Running terminal: ls /"]), [
    "Running terminal: ls ~",
    "Running terminal: ls /",
  ]);
});

test("only consecutive identicals coalesce; a later repeat is its own thought", () => {
  const t = new ThoughtThrottler();
  // a, a → a(×2); then b; then a again → separate a.
  assert.deepEqual(drain(t, ["a", "a", "b", "a"]), ["a (×2)", "b", "a"]);
});

test("a distinct command emits when the next one arrives; the last on flush", () => {
  const t = new ThoughtThrottler();
  assert.deepEqual(t.push("first"), []); // held
  assert.deepEqual(t.push("second"), [{ body: "first", count: 1 }]);
  assert.deepEqual(t.flush(), [{ body: "second", count: 1 }]);
});

test("flush is a no-op once drained", () => {
  const t = new ThoughtThrottler();
  t.push("a");
  assert.deepEqual(t.flush(), [{ body: "a", count: 1 }]);
  assert.deepEqual(t.flush(), []);
});

test("cancel drops the held thought and silences further pushes", () => {
  const t = new ThoughtThrottler();
  t.push("a");
  t.cancel();
  assert.deepEqual(t.flush(), []);
  assert.deepEqual(t.push("b"), []);
});

test("blank thoughts are ignored", () => {
  const t = new ThoughtThrottler();
  assert.deepEqual(t.push("   "), []);
  assert.deepEqual(t.push(""), []);
  assert.deepEqual(t.flush(), []);
});

test("a burst of distinct commands loses none", () => {
  const t = new ThoughtThrottler();
  const cmds = Array.from({ length: 20 }, (_, i) => `cmd ${i}`);
  assert.deepEqual(drain(t, cmds), cmds);
});
