/**
 * Centralized secret redaction for logs.
 *
 * Two surfaces leak secrets when debug logging is on: request headers (the
 * Linear HMAC signature, OAuth bearer tokens) and request/response bodies
 * (OAuth token exchanges, API keys). Everything logged should pass through here
 * so enabling debug logging is always safe.
 */

const REDACTED = "[REDACTED]";

/** Header names whose values are always secret. Compared case-insensitively. */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "linear-signature",
  "x-api-key",
  "x-hermes-session-key",
]);

/**
 * Returns a copy of `headers` with sensitive values replaced by `[REDACTED]`.
 * Array-valued headers (e.g. `set-cookie`) are collapsed to a single string.
 */
export function redactHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      out[key] = REDACTED;
    } else {
      out[key] = Array.isArray(value) ? value.join(", ") : String(value);
    }
  }
  return out;
}

// `Bearer <token>` anywhere in a string (Authorization header echoed into a body, etc.).
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/g;
// `"access_token": "…"`, `client_secret=…`, `api_key: …`, etc. — JSON or form shapes.
const TOKEN_FIELD_RE =
  /("?(?:access_token|refresh_token|client_secret|api_key|apikey|token|password)"?\s*[:=]\s*"?)([^"\s,&}]+)/gi;

/**
 * Replaces OAuth bearer tokens and common secret fields in free text with
 * `[REDACTED]`, preserving surrounding structure so the line stays readable.
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  return input
    .replace(BEARER_RE, `$1${REDACTED}`)
    .replace(TOKEN_FIELD_RE, `$1${REDACTED}`);
}
