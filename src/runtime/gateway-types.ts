import type { OpenClawPluginApi, PluginConfig } from "../types.js";

export type BackendName = "openclaw" | "hermes";

/**
 * Normalized agent-turn input handed to every gateway.
 *
 * This is the single contract both @Clawd (OpenClaw) and future backends
 * (Hermes, a hosted Claude API agent, …) consume. Fields that a particular
 * backend does not need are simply ignored by that gateway — the shape stays
 * stable so a third backend can be added without reshaping the interface.
 */
export interface GatewayIssueContext {
  id: string;
  identifier: string;
  title: string;
  url: string;
}

export interface GatewayTurnInput {
  agentId: string;
  sessionKey: string;
  label: string;
  /** Fully-built turn message (prompt) for this turn. */
  prompt: string;
  idempotencyKey: string;
  extraSystemPrompt: string;
  timeoutMs: number;
  /** Optional abort signal; backends that support cancellation honor it. */
  signal?: AbortSignal;
  /** Optional issue context for backends that consume it directly. */
  issue?: GatewayIssueContext;
}

/**
 * A single streamed event from a gateway turn.
 *
 * `thought` / `action` are intermediate, surfaced live. `completion` is the
 * terminal visible reply — an empty body means the model produced nothing
 * publishable. OpenClaw emits exactly one `completion`; streaming backends
 * emit `thought`/`action` events before it.
 */
export interface GatewayThoughtEvent {
  type: "thought";
  body: string;
}

export interface GatewayActionEvent {
  type: "action";
  action: string;
  parameter?: string;
  result?: string;
}

export interface GatewayCompletionEvent {
  type: "completion";
  body: string;
}

export type GatewayEvent =
  | GatewayThoughtEvent
  | GatewayActionEvent
  | GatewayCompletionEvent;

/** Terminal metadata for a completed gateway turn. */
export interface GatewayResult {
  backend: BackendName;
  /** True when the turn produced a visible reply. */
  ok: boolean;
  /** The resolved visible reply (empty when none). */
  reply: string;
  /** Raw backend payload, retained for logging / tool-trace. */
  raw?: unknown;
}

export interface Gateway {
  readonly backend: BackendName;
  /**
   * Run one agent turn: yields a stream of `GatewayEvent`s and returns a
   * terminal `GatewayResult`.
   */
  runTurn(
    api: OpenClawPluginApi,
    cfg: PluginConfig,
    input: GatewayTurnInput,
  ): AsyncGenerator<GatewayEvent, GatewayResult, void>;
}
