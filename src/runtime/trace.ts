import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { OpenClawPluginApi } from "../types.js";
import { readHeader } from "../util.js";
import { redactSecrets } from "./redact.js";

type Logger = OpenClawPluginApi["logger"];

/**
 * Correlation ID for one inbound webhook: Linear's `linear-delivery` header
 * when present (so the trace lines up with Linear's own delivery record),
 * otherwise a generated UUID. Threaded through the whole turn so a single
 * `grep <correlation_id>` reconstructs the full life of a webhook.
 */
export function resolveCorrelationId(req: IncomingMessage): string {
  return readHeader(req, "linear-delivery") || randomUUID();
}

/**
 * Emits one structured, greppable log line for a named phase of a webhook's
 * life: `linear cid=<id> phase=<phase> k=v …`. Field values are run through the
 * secret redactor and quoted when they contain whitespace.
 */
export function logPhase(
  logger: Logger,
  cid: string,
  phase: TracePhase,
  fields?: Record<string, unknown>,
): void {
  const parts = [`linear cid=${cid}`, `phase=${phase}`];
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null || value === "") continue;
      parts.push(`${key}=${formatField(value)}`);
    }
  }
  logger.info?.(parts.join(" "));
}

export type TracePhase =
  | "webhook_received"
  | "signature_verified"
  | "signature_rejected"
  | "turn_started"
  | "gateway_event"
  | "activity_posted"
  | "turn_completed"
  | "turn_errored";

function formatField(value: unknown): string {
  const text = redactSecrets(String(value));
  return /\s/.test(text) ? JSON.stringify(text) : text;
}
