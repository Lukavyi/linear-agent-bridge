import test from "node:test";
import assert from "node:assert/strict";

import { redactHeaders, redactSecrets } from "./redact.js";

test("redactHeaders masks sensitive headers, case-insensitively", () => {
  const out = redactHeaders({
    "Content-Type": "application/json",
    Authorization: "Bearer abc.def.ghi",
    "linear-signature": "deadbeef",
    "X-Api-Key": "sk-123",
    "X-Hermes-Session-Key": "linear:session-1",
    cookie: "a=1; b=2",
    "linear-delivery": "uuid-1",
  });
  assert.deepEqual(out, {
    "Content-Type": "application/json",
    Authorization: "[REDACTED]",
    "linear-signature": "[REDACTED]",
    "X-Api-Key": "[REDACTED]",
    "X-Hermes-Session-Key": "[REDACTED]",
    cookie: "[REDACTED]",
    "linear-delivery": "uuid-1",
  });
});

test("redactHeaders collapses array-valued headers and handles undefined", () => {
  assert.deepEqual(redactHeaders(undefined), {});
  assert.deepEqual(redactHeaders({ "set-cookie": ["a=1", "b=2"] }), {
    "set-cookie": "[REDACTED]",
  });
  assert.deepEqual(redactHeaders({ accept: ["a", "b"] }), { accept: "a, b" });
});

const SECRET_CASES: Array<[string, string, string]> = [
  ["bearer token in text", "Authorization: Bearer abc123.def-456", "Authorization: Bearer [REDACTED]"],
  ["json access_token", '{"access_token":"ya29.secret","x":1}', '{"access_token":"[REDACTED]","x":1}'],
  ["json refresh_token", '{"refresh_token": "rt-xyz"}', '{"refresh_token": "[REDACTED]"}'],
  ["form client_secret", "client_secret=shhh&grant_type=code", "client_secret=[REDACTED]&grant_type=code"],
  ["api_key field", "api_key: sk-abcdEF", "api_key: [REDACTED]"],
  ["no secret untouched", "just a normal log line", "just a normal log line"],
];

for (const [name, input, expected] of SECRET_CASES) {
  test(`redactSecrets: ${name}`, () => {
    assert.equal(redactSecrets(input), expected);
  });
}

test("redactSecrets handles empty input", () => {
  assert.equal(redactSecrets(""), "");
});
