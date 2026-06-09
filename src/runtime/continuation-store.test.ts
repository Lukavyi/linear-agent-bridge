import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  clearContinuationCache,
  loadContinuation,
  resolveContinuationStorePath,
  saveContinuation,
} from "./continuation-store.js";

async function tmpStore(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-cont-"));
  return path.join(dir, "nested", "hermes-continuations.json");
}

test("a fresh session has no stored continuation", async () => {
  const file = await tmpStore();
  assert.equal(await loadContinuation(file, "session-1"), undefined);
});

test("saves and reads back a response id for a session", async () => {
  const file = await tmpStore();
  await saveContinuation(file, "session-1", "resp_abc");
  assert.equal(await loadContinuation(file, "session-1"), "resp_abc");
});

test("the latest save wins for a session", async () => {
  const file = await tmpStore();
  await saveContinuation(file, "session-1", "resp_1");
  await saveContinuation(file, "session-1", "resp_2");
  assert.equal(await loadContinuation(file, "session-1"), "resp_2");
});

test("distinct sessions keep distinct chains (no cross-session leakage)", async () => {
  const file = await tmpStore();
  await saveContinuation(file, "session-a", "resp_a");
  await saveContinuation(file, "session-b", "resp_b");
  assert.equal(await loadContinuation(file, "session-a"), "resp_a");
  assert.equal(await loadContinuation(file, "session-b"), "resp_b");
});

test("the store survives a restart (re-read from disk with a cold cache)", async () => {
  const file = await tmpStore();
  await saveContinuation(file, "session-1", "resp_persisted");
  await saveContinuation(file, "session-2", "resp_two");

  // Simulate a process restart: drop the in-memory cache, read from the file.
  clearContinuationCache();
  assert.equal(await loadContinuation(file, "session-1"), "resp_persisted");
  assert.equal(await loadContinuation(file, "session-2"), "resp_two");
});

test("concurrent saves to different sessions do not clobber each other", async () => {
  const file = await tmpStore();
  await Promise.all([
    saveContinuation(file, "s1", "r1"),
    saveContinuation(file, "s2", "r2"),
    saveContinuation(file, "s3", "r3"),
  ]);
  clearContinuationCache();
  assert.equal(await loadContinuation(file, "s1"), "r1");
  assert.equal(await loadContinuation(file, "s2"), "r2");
  assert.equal(await loadContinuation(file, "s3"), "r3");
});

test("empty session id or response id is a no-op", async () => {
  const file = await tmpStore();
  await saveContinuation(file, "", "resp_x");
  await saveContinuation(file, "session-1", "");
  clearContinuationCache();
  assert.equal(await loadContinuation(file, "session-1"), undefined);
});

test("resolveContinuationStorePath honors an explicit path, else sits beside the token store", () => {
  assert.equal(
    resolveContinuationStorePath("/data/custom.json", "/vol/tokens.json"),
    "/data/custom.json",
  );
  assert.equal(
    resolveContinuationStorePath(undefined, "/vol/.pi/linear-oauth.json"),
    path.join("/vol/.pi", "hermes-continuations.json"),
  );
});
