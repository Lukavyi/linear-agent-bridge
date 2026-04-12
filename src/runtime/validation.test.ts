import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { verifySignature } from "./validation.js";

test("verifySignature accepts a correct sha256 hex digest", () => {
  const secret = "top-secret";
  const raw = Buffer.from('{"hello":"world"}');
  const signature = createHmac("sha256", secret).update(raw).digest("hex");

  assert.equal(verifySignature(secret, signature, raw), true);
});

test("verifySignature rejects a missing or invalid signature", () => {
  const secret = "top-secret";
  const raw = Buffer.from('{"hello":"world"}');

  assert.equal(verifySignature(secret, undefined, raw), false);
  assert.equal(verifySignature(secret, "deadbeef", raw), false);
});
