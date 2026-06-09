import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeCfg } from "../config.js";
import {
  ACTIVITY_MUTATION,
  SESSION_UPDATE_MUTATION,
} from "../graphql/mutations.js";
import {
  AGENT_SESSION_ACTIVITIES_QUERY,
  ISSUE_PROMPT_CONTEXT_QUERY,
} from "../graphql/queries.js";
import { callLinear } from "../linear-client.js";
import type {
  ActivityContent,
  OpenClawPluginApi,
  PluginConfig,
} from "../types.js";
import {
  readArray,
  readBody,
  readHeader,
  readObject,
  readString,
  sendJson,
  sleep,
} from "../util.js";
import { applyIssuePolicy } from "./issue-policy.js";
import {
  rememberResolvedSessionHint,
  resolveSessionIdWithFallback,
} from "./session-resolver.js";
import { isSelfAuthoredComment } from "./skip-filter.js";
import { verifySignature } from "./validation.js";
import { readGatewayHistory } from "./gateway.js";
import { createGateway } from "./backend.js";
import {
  loadContinuation,
  resolveContinuationStorePath,
  saveContinuation,
} from "./continuation-store.js";
import { mapGatewayEventToActivity } from "./event-mapper.js";
import { logPhase, resolveCorrelationId } from "./trace.js";
import { redactHeaders } from "./redact.js";
import type {
  Gateway,
  GatewayCompletionEvent,
  GatewayResult,
} from "./gateway-types.js";
import {
  buildExtraSystemPrompt,
  buildTurnMessage,
  type HistoryEntry,
  type IssueCommentEntry,
} from "./prompt.js";
import { buildToolTraceActivities } from "./tool-trace.js";
import {
  normalizeLinearWebhookPayload,
  parseLinearTrigger,
  type LinearTrigger,
} from "./payload.js";

const MAX_BODY = 2 * 1024 * 1024;
const WEBHOOK_STALE_MS = 60_000;
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const RECENT_KEY_TTL_MS = 6 * 60 * 60 * 1000;
const ACTIVITY_RETRY_DELAYS_MS = [0, 250, 1000, 2500];
const BOOTSTRAP_DEBOUNCE_MS = 2000;
const BOOTSTRAP_DUPLICATE_WINDOW_MS = 5000;
const PROMPTED_DUPLICATE_WINDOW_MS = 5000;
const COMMENT_PROMPT_HINT_TTL_MS = 2 * 60 * 1000;
const MISSING_PROMPT_HINT_DELAYS_MS = [0, 250, 500, 1000];

const sessionQueues = new Map<string, Promise<void>>();
const recentEventKeys = new Map<string, number>();
const recentTerminalKeys = new Map<string, number>();
const recentSessionCreatedAt = new Map<string, number>();
const recentBootstrapCommentRunsAt = new Map<string, number>();
const recentPromptedSessionRunsAt = new Map<string, number>();
const recentCommentPromptHints = new Map<string, PromptHint>();
const sessionRunStates = new Map<string, SessionRunState>();

interface PromptHint {
  text: string;
  commentId: string;
  recordedAt: number;
}

interface SessionRunState {
  nextRunId: number;
  activeRunId?: number;
  suppressedRunId?: number;
  /** Aborts the in-flight backend request for `activeRunId` on cancel. */
  activeController?: AbortController;
}

interface ActivityPostResult {
  ok: boolean;
  status?: number;
  error?: string;
  attempts: number;
}

export function createLinearWebhook(
  api: OpenClawPluginApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const gateway = createGateway(api);
  api.logger.info?.(`linear runtime: selected backend=${gateway.backend}`);
  return async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return;
    }

    // Log the instant Linear's request hits us — before reading the body — so a
    // hung or truncated upload still leaves a greppable first line for the cid.
    const cid = resolveCorrelationId(req);
    const receivedFields: Record<string, unknown> = {
      method: req.method,
      url: req.url ?? undefined,
      contentLength: readHeader(req, "content-length") || undefined,
      delivery: readHeader(req, "linear-delivery") || undefined,
      signed: readHeader(req, "linear-signature") ? "1" : "0",
    };
    if (api.logger.debug) {
      receivedFields.headers = JSON.stringify(
        redactHeaders(req.headers as Record<string, unknown>),
      );
    }
    logPhase(api.logger, cid, "webhook_received", receivedFields);

    const read = await readBody(req, MAX_BODY);
    if (!read.ok) {
      logPhase(api.logger, cid, "webhook_rejected", {
        reason: "body_read_failed",
        status: read.status,
        error: read.error,
      });
      sendJson(res, read.status, { ok: false, error: read.error });
      return;
    }

    const cfg = normalizeCfg(api.pluginConfig);
    const signature = readHeader(req, "linear-signature");
    if (cfg.linearWebhookSecret) {
      if (!verifySignature(cfg.linearWebhookSecret, signature, read.body)) {
        logPhase(api.logger, cid, "signature_rejected");
        res.statusCode = 401;
        res.end("Unauthorized");
        return;
      }
      logPhase(api.logger, cid, "signature_verified");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(read.body.toString("utf8"));
    } catch {
      logPhase(api.logger, cid, "webhook_rejected", { reason: "invalid_json" });
      sendJson(res, 400, { ok: false, error: "Invalid JSON" });
      return;
    }

    const payload = normalizeLinearWebhookPayload(parsed);
    const delivery = readHeader(req, "linear-delivery");
    const enrichedPayload = delivery ? { ...payload, linearDelivery: delivery } : payload;
    const trigger = parseLinearTrigger(enrichedPayload);
    logPhase(api.logger, cid, "webhook_parsed", {
      type: readString(payload.type) || undefined,
      action: readString(payload.action) || trigger?.action,
      source: trigger?.source,
      session: trigger?.sessionId,
      issue: trigger?.issueIdentifier,
      signal: trigger?.signal,
    });
    if (trigger?.webhookTimestamp) {
      const ageMs = Math.abs(Date.now() - trigger.webhookTimestamp);
      if (ageMs > WEBHOOK_STALE_MS) {
        logPhase(api.logger, cid, "webhook_rejected", {
          reason: "stale",
          ageMs,
        });
        res.statusCode = 401;
        res.end("Stale webhook");
        return;
      }
    }

    res.statusCode = 202;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true }));

    queueMicrotask(() => {
      processWebhook(api, cfg, enrichedPayload, trigger, gateway, cid).catch((error) => {
        api.logger.warn?.(
          `linear runtime webhook error: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
  };
}

async function processWebhook(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  payload: Record<string, unknown>,
  initialTrigger: LinearTrigger | null,
  gateway: Gateway,
  cid: string,
): Promise<void> {
  const kind = readString(payload.type) ?? "";
  if (
    kind === "PermissionChange" ||
    kind === "OAuthApp" ||
    kind === "AppUserNotification"
  ) {
    logPhase(api.logger, cid, "webhook_ignored", { reason: "type", type: kind });
    return;
  }

  let trigger = initialTrigger;
  if ((readString(payload.type) ?? "").toLowerCase() === "comment") {
    const selfAuthored = await isSelfAuthoredComment(api, cfg, payload);
    const allowArtificialRootBootstrap =
      shouldAllowSelfAuthoredBootstrap(payload);
    if (!trigger) {
      const sessionId = await resolveCommentSession(api, cfg, payload);
      if (sessionId) {
        trigger = parseLinearTrigger({ ...payload, agentSessionId: sessionId });
      }
    }
    if (selfAuthored && !allowArtificialRootBootstrap) {
      logPhase(api.logger, cid, "webhook_skipped", { reason: "self_authored_comment" });
      return;
    }
  }

  if (trigger) {
    rememberCommentPromptHint(trigger, payload);
  }

  if (!trigger) {
    logPhase(api.logger, cid, "webhook_ignored", {
      reason: "no_trigger",
      type: kind || "unknown",
      action: readString(payload.action) || undefined,
    });
    return;
  }

  if (shouldIgnoreNativeCommentTrigger(payload, trigger)) {
    logPhase(api.logger, cid, "webhook_ignored", {
      reason: "native_comment_trigger",
      session: trigger.sessionId,
      action: trigger.action,
    });
    return;
  }

  const bootstrapCommentCandidate = isBootstrapCommentCandidate(payload, trigger);
  if (trigger.action === "created") {
    if (hasFreshSessionMarker(recentBootstrapCommentRunsAt, trigger.sessionId)) {
      logPhase(api.logger, cid, "webhook_skipped", {
        reason: "created_bootstrap_duplicate",
        session: trigger.sessionId,
      });
      return;
    }
    markSessionMarker(recentSessionCreatedAt, trigger.sessionId);
  } else if (bootstrapCommentCandidate) {
    if (await shouldSkipBootstrapCommentDuplicate(api, trigger.sessionId)) {
      logPhase(api.logger, cid, "webhook_skipped", {
        reason: "bootstrap_comment_duplicate",
        session: trigger.sessionId,
      });
      return;
    }
    markSessionMarker(recentBootstrapCommentRunsAt, trigger.sessionId);
  } else {
    const promptedDuplicateKey = buildPromptedDuplicateKey(trigger);
    if (promptedDuplicateKey) {
      if (
        await shouldSkipPromptedDuplicate(
          trigger,
          promptedDuplicateKey,
        )
      ) {
        logPhase(api.logger, cid, "webhook_skipped", {
          reason: "prompted_duplicate",
          session: trigger.sessionId,
          source: trigger.source,
        });
        return;
      }
    }
  }

  rememberResolvedSessionHint(
    {
      issueId: trigger.issueId,
      commentId: trigger.commentId,
      parentId:
        readString(readObject(payload.comment)?.parentId) ??
        readString(payload.parentId) ??
        "",
    },
    trigger.sessionId,
  );

  if (hasRecentKey(recentEventKeys, trigger.eventKey)) {
    logPhase(api.logger, cid, "webhook_skipped", {
      reason: "duplicate_event",
      eventKey: trigger.eventKey,
      session: trigger.sessionId,
    });
    return;
  }
  markRecentKey(recentEventKeys, trigger.eventKey);

  if (trigger.signal === "stop") {
    logPhase(api.logger, cid, "turn_enqueued", {
      session: trigger.sessionId,
      kind: "stop",
    });
    await handleStopSignal(api, cfg, trigger);
    return;
  }

  logPhase(api.logger, cid, "turn_enqueued", {
    session: trigger.sessionId,
    action: trigger.action,
  });
  enqueueSessionTurn(trigger.sessionId, async () => {
    await executeTurn(api, cfg, trigger, gateway, cid);
  });
}

export function shouldAllowSelfAuthoredBootstrap(
  payload: Record<string, unknown>,
): boolean {
  return payload.isArtificialAgentSessionRoot === true && isCommentCreate(payload);
}

export function isBootstrapCommentCandidate(
  payload: Record<string, unknown>,
  trigger: LinearTrigger,
): boolean {
  if (trigger.source !== "comment" || trigger.action !== "prompted") return false;
  if (!isCommentCreate(payload)) return false;
  if (payload.isArtificialAgentSessionRoot === true) return false;
  const parentId =
    readString(readObject(payload.comment)?.parentId) ??
    readString(payload.parentId) ??
    "";
  return !parentId;
}

export function shouldIgnoreNativeCommentTrigger(
  payload: Record<string, unknown>,
  trigger: LinearTrigger,
): boolean {
  if (trigger.source !== "comment") return false;
  if (payload.isArtificialAgentSessionRoot === true) return false;
  return Boolean(trigger.sessionId);
}

function isCommentCreate(payload: Record<string, unknown>): boolean {
  const action = (readString(payload.action) ?? "").toLowerCase();
  return action === "create" || action === "created";
}

export function buildPromptedDuplicateKey(
  trigger: LinearTrigger,
): string {
  if (trigger.action !== "prompted") return "";
  const text = trigger.prompt.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const digest = createHash("sha1").update(text).digest("hex").slice(0, 16);
  return `${trigger.sessionId}:${digest}`;
}

export function shouldSkipPromptedDuplicate(
  _trigger: LinearTrigger,
  duplicateKey: string,
): boolean {
  if (hasFreshPromptedMarker(recentPromptedSessionRunsAt, duplicateKey)) {
    return true;
  }

  markPromptedMarker(recentPromptedSessionRunsAt, duplicateKey);
  return false;
}

async function shouldSkipBootstrapCommentDuplicate(
  api: OpenClawPluginApi,
  sessionId: string,
): Promise<boolean> {
  if (hasFreshSessionMarker(recentSessionCreatedAt, sessionId)) return true;
  await sleep(BOOTSTRAP_DEBOUNCE_MS);
  return hasFreshSessionMarker(recentSessionCreatedAt, sessionId);
}

function hasFreshPromptedMarker(
  store: Map<string, number>,
  key: string,
): boolean {
  pruneMarkers(store, PROMPTED_DUPLICATE_WINDOW_MS);
  const timestamp = store.get(key);
  return typeof timestamp === "number" && Date.now() - timestamp <= PROMPTED_DUPLICATE_WINDOW_MS;
}

function markPromptedMarker(
  store: Map<string, number>,
  key: string,
): void {
  pruneMarkers(store, PROMPTED_DUPLICATE_WINDOW_MS);
  store.set(key, Date.now());
}

export function resetPromptedDuplicateState(): void {
  recentPromptedSessionRunsAt.clear();
}

export function resetCommentPromptHintState(): void {
  recentCommentPromptHints.clear();
}

export function rememberCommentPromptHint(
  trigger: LinearTrigger,
  payload: Record<string, unknown>,
): void {
  if (trigger.source !== "comment") return;
  const text = extractCommentPromptHintText(trigger, payload);
  if (!text) return;
  pruneCommentPromptHints();
  recentCommentPromptHints.set(trigger.sessionId, {
    text,
    commentId: trigger.commentId,
    recordedAt: Date.now(),
  });
}

export async function hydrateTriggerPromptFromCommentHint(
  trigger: LinearTrigger,
  delaysMs: number[] = MISSING_PROMPT_HINT_DELAYS_MS,
): Promise<LinearTrigger> {
  if (trigger.action !== "prompted") return trigger;
  if (trigger.prompt.trim()) return trigger;

  for (let index = 0; index < delaysMs.length; index += 1) {
    const delayMs = delaysMs[index] ?? 0;
    if (delayMs > 0) await sleep(delayMs);
    const hint = consumeFreshCommentPromptHint(trigger.sessionId);
    if (!hint) continue;
    return {
      ...trigger,
      prompt: hint.text,
      commentId: trigger.commentId || hint.commentId,
    };
  }

  return trigger;
}

function extractCommentPromptHintText(
  trigger: LinearTrigger,
  payload: Record<string, unknown>,
): string {
  const text =
    trigger.prompt.trim() ||
    readString(readObject(payload.comment)?.body)?.trim() ||
    readString(payload.body)?.trim() ||
    "";
  return text;
}

function consumeFreshCommentPromptHint(sessionId: string): PromptHint | undefined {
  pruneCommentPromptHints();
  const hint = recentCommentPromptHints.get(sessionId);
  if (!hint) return undefined;
  recentCommentPromptHints.delete(sessionId);
  return hint;
}

function pruneCommentPromptHints(): void {
  const cutoff = Date.now() - COMMENT_PROMPT_HINT_TTL_MS;
  for (const [key, value] of recentCommentPromptHints.entries()) {
    if (value.recordedAt < cutoff) {
      recentCommentPromptHints.delete(key);
    }
  }
}

function hasFreshSessionMarker(
  store: Map<string, number>,
  sessionId: string,
): boolean {
  pruneMarkers(store, BOOTSTRAP_DUPLICATE_WINDOW_MS);
  const timestamp = store.get(sessionId);
  return typeof timestamp === "number" && Date.now() - timestamp <= BOOTSTRAP_DUPLICATE_WINDOW_MS;
}

function markSessionMarker(
  store: Map<string, number>,
  sessionId: string,
): void {
  pruneMarkers(store, BOOTSTRAP_DUPLICATE_WINDOW_MS);
  store.set(sessionId, Date.now());
}

function pruneMarkers(store: Map<string, number>, windowMs: number): void {
  const cutoff = Date.now() - windowMs;
  for (const [key, timestamp] of store.entries()) {
    if (timestamp < cutoff) store.delete(key);
  }
}

async function resolveCommentSession(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  payload: Record<string, unknown>,
): Promise<string> {
  const delaysMs = payload.isArtificialAgentSessionRoot === true
    ? [250, 1000, 2500, 5000]
    : [0, 250, 1000];
  for (let index = 0; index < delaysMs.length; index += 1) {
    const delayMs = delaysMs[index];
    if (delayMs > 0) await sleep(delayMs);
    const sessionId = await resolveSessionIdWithFallback(api, cfg, payload);
    if (sessionId) return sessionId;
  }
  return "";
}

function enqueueSessionTurn(
  sessionId: string,
  task: () => Promise<void>,
): void {
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      if (sessionQueues.get(sessionId) === next) {
        sessionQueues.delete(sessionId);
      }
    });
  sessionQueues.set(sessionId, next);
}

async function handleStopSignal(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  trigger: LinearTrigger,
): Promise<void> {
  const state = getSessionRunState(trigger.sessionId);
  if (state.activeRunId !== undefined) {
    state.suppressedRunId = state.activeRunId;
    // Actually stop the backend: aborting the in-flight HTTP request closes the
    // connection so Hermes stops generating instead of running to completion
    // with its output merely suppressed. Backends that ignore the signal
    // (OpenClaw) are unaffected — their output stays suppressed as before.
    state.activeController?.abort();
  }
  await postTerminalActivity(api, cfg, trigger, {
    type: "response",
    body: buildStopText(trigger),
  });
}

async function executeTurn(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  inputTrigger: LinearTrigger,
  gateway: Gateway,
  cid: string,
): Promise<void> {
  let trigger = await hydrateTriggerPromptFromCommentHint(inputTrigger);
  logPhase(api.logger, cid, "turn_started", {
    session: trigger.sessionId,
    backend: gateway.backend,
    action: trigger.action,
    issue: trigger.issueIdentifier,
  });
  if (!inputTrigger.prompt.trim() && trigger.prompt.trim()) {
    api.logger.info?.(
      `linear runtime: hydrated missing prompt from comment hint session=${trigger.sessionId}`,
    );
  }
  const state = getSessionRunState(trigger.sessionId);
  const runId = state.nextRunId + 1;
  state.nextRunId = runId;
  state.activeRunId = runId;
  // Per-run abort handle so an `agentSession.canceled` for THIS session stops
  // THIS run's backend request without touching any other session.
  const controller = new AbortController();
  state.activeController = controller;
  const agentId = cfg.agentId ?? cfg.devAgentId ?? "main";
  const sessionKey = buildOpenClawSessionKey(agentId, trigger.sessionId);
  let runStartedAtMs = Date.now();

  // Hermes keeps conversation state server-side; resume it across follow-up
  // prompts by replaying the prior turn's response id. Backends with their own
  // session memory (OpenClaw) opt out — no store path, no continuation id.
  const usesContinuation = gateway.backend === "hermes";
  const continuationPath = usesContinuation
    ? resolveContinuationStorePath(
        cfg.hermesContinuationStorePath,
        cfg.linearTokenStorePath,
      )
    : "";
  let priorContinuationId: string | undefined;
  if (usesContinuation) {
    priorContinuationId = await loadContinuation(
      continuationPath,
      trigger.sessionId,
    ).catch((error) => {
      api.logger.warn?.(
        `linear runtime: continuation load failed session=${trigger.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    });
    if (priorContinuationId) {
      api.logger.info?.(
        `linear runtime: resuming hermes conversation session=${trigger.sessionId} previous_response_id=${priorContinuationId}`,
      );
    }
  }

  try {
    const thought = await postActivity(
      api,
      cfg,
      trigger.sessionId,
      { type: "thought", body: buildThinkingText(trigger) },
    );
    if (!thought.ok) {
      api.logger.warn?.(
        `linear runtime: initial thought publish failed session=${trigger.sessionId} status=${thought.status ?? "n/a"} error=${thought.error ?? "unknown"}`,
      );
    } else {
      api.logger.info?.(
        `linear runtime: initial thought published session=${trigger.sessionId} action=${trigger.action} attempts=${thought.attempts}`,
      );
    }

    if (trigger.action === "created") {
      const external = resolveExternalUrl(cfg, trigger);
      if (external) {
        await updateSessionExternalUrl(
          api,
          cfg,
          trigger.sessionId,
          external.url,
          external.label,
        );
      }
      if (trigger.issueId) {
        await applyIssuePolicy(api, cfg, trigger.issueId);
      }
    }

    const [history, issueComments] = await Promise.all([
      loadActivityHistory(api, cfg, trigger.sessionId),
      loadIssueCommentContext(api, cfg, trigger),
    ]);
    runStartedAtMs = Date.now();
    const run = gateway.runTurn(api, cfg, {
      agentId,
      sessionKey,
      label: buildLabel(trigger),
      prompt: buildTurnMessage({ cfg, trigger, history, issueComments }),
      idempotencyKey: trigger.eventKey,
      extraSystemPrompt: buildExtraSystemPrompt(),
      timeoutMs: AGENT_TIMEOUT_MS,
      signal: controller.signal,
      continuationId: priorContinuationId,
      issue: trigger.issueId
        ? {
            id: trigger.issueId,
            identifier: trigger.issueIdentifier,
            title: trigger.issueTitle,
            url: trigger.issueUrl,
          }
        : undefined,
    });

    // Drain intermediate events (thought/action) live; defer the terminal
    // completion until after the suppression check and tool-trace pass so the
    // ordering of @Clawd's output is preserved exactly.
    let completionEvent: GatewayCompletionEvent | undefined;
    let result: GatewayResult | undefined;
    for (;;) {
      const next = await run.next();
      if (next.done) {
        result = next.value;
        break;
      }
      const event = next.value;
      logPhase(api.logger, cid, "gateway_event", { type: event.type });
      if (event.type === "completion") {
        completionEvent = event;
        continue;
      }
      const activity = mapGatewayEventToActivity(event);
      if (activity) {
        await postActivity(api, cfg, trigger.sessionId, activity);
        logPhase(api.logger, cid, "activity_posted", {
          type: activity.type,
          terminal: false,
        });
      }
    }

    if (state.suppressedRunId === runId) {
      api.logger.info?.(
        `linear runtime: suppressed terminal output for stopped run session=${trigger.sessionId}`,
      );
      return;
    }

    api.logger.info?.(`linear runtime: raw gateway result ${safePreview(result?.raw)}`);

    // Persist the backend's resume token so the next prompt in this Linear
    // session continues the same server-side conversation.
    if (usesContinuation && result?.continuationId) {
      await saveContinuation(
        continuationPath,
        trigger.sessionId,
        result.continuationId,
      ).catch((error) => {
        api.logger.warn?.(
          `linear runtime: continuation save failed session=${trigger.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }

    await maybePostToolTrace(api, cfg, trigger.sessionId, sessionKey, runStartedAtMs);

    const terminalEvent: GatewayCompletionEvent =
      completionEvent ?? { type: "completion", body: result?.reply ?? "" };
    const terminalActivity = mapGatewayEventToActivity(terminalEvent);
    if (terminalActivity) {
      await postTerminalActivity(api, cfg, trigger, terminalActivity);
      logPhase(api.logger, cid, "activity_posted", {
        type: terminalActivity.type,
        terminal: true,
      });
    }
    logPhase(api.logger, cid, "turn_completed", {
      session: trigger.sessionId,
      ok: result?.ok ?? false,
    });
  } catch (error) {
    if (state.suppressedRunId === runId) {
      api.logger.info?.(
        `linear runtime: ignored error from stopped run session=${trigger.sessionId}`,
      );
      return;
    }
    await maybePostToolTrace(api, cfg, trigger.sessionId, sessionKey, runStartedAtMs);
    const message = error instanceof Error ? error.message : String(error);
    logPhase(api.logger, cid, "turn_errored", {
      session: trigger.sessionId,
      error: message,
    });
    await postTerminalActivity(api, cfg, trigger, {
      type: "error",
      body: `Agent run failed: ${message}`,
    });
  } finally {
    if (state.activeRunId === runId) state.activeRunId = undefined;
    if (state.suppressedRunId === runId) state.suppressedRunId = undefined;
    if (state.activeController === controller) state.activeController = undefined;
  }
}

async function loadActivityHistory(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  sessionId: string,
): Promise<HistoryEntry[]> {
  const result = await callLinear(api, cfg, "agentSession(activities)", {
    query: AGENT_SESSION_ACTIVITIES_QUERY,
    variables: { id: sessionId },
  });
  if (!result.ok) return [];

  const session = readObject(result.data?.agentSession);
  const activities = readObject(session?.activities);
  const edges = readArray(activities?.edges);
  const history: HistoryEntry[] = [];

  for (const edge of edges) {
    const node = readObject(readObject(edge)?.node);
    const content = readObject(node?.content);
    if (!content) continue;
    const typename = readString(content.__typename) ?? "Activity";
    const action = readString(content.action);
    const parameter = readString(content.parameter);
    const resultText = readString(content.result);
    const body = readString(content.body);
    let text = body ?? "";
    if (!text && action) {
      text = [action, parameter, resultText].filter(Boolean).join(" | ");
    }
    text = text.trim();
    if (!text) continue;
    history.push({
      type: normalizeActivityType(typename),
      text,
      updatedAt: readString(node?.updatedAt),
    });
  }

  return history;
}

async function loadIssueCommentContext(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  trigger: LinearTrigger,
): Promise<IssueCommentEntry[]> {
  if (!trigger.issueId) return [];

  const result = await callLinear(api, cfg, "issue(prompt-context)", {
    query: ISSUE_PROMPT_CONTEXT_QUERY,
    variables: { id: trigger.issueId },
  });
  if (!result.ok) return [];

  const issue = readObject(result.data?.issue);
  const comments = readObject(issue?.comments);
  const nodes = readArray(comments?.nodes);
  const entries: IssueCommentEntry[] = [];

  for (const node of nodes) {
    const comment = readObject(node);
    if (!comment) continue;
    if (readString(comment.parentId)) continue;
    if (readString(readObject(comment.botActor)?.id)) continue;
    if (readString(readObject(comment.agentSession)?.id)) continue;
    const agentSessions = readArray(readObject(comment.agentSessions)?.nodes);
    if (agentSessions.length > 0) continue;
    const id = readString(comment.id) ?? "";
    if (id && id === trigger.commentId) continue;
    const text = compactText(readString(comment.body) ?? "");
    if (!text) continue;
    const author =
      compactText(readString(readObject(comment.user)?.name) ?? "") || "Unknown";
    entries.push({ author, text });
  }

  return entries.slice(-8);
}

function compactText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function normalizeActivityType(typename: string): string {
  const raw = typename.replace(/^AgentActivity/, "").replace(/Content$/, "");
  return raw ? raw.toLowerCase() : "activity";
}

function getSessionRunState(sessionId: string): SessionRunState {
  const existing = sessionRunStates.get(sessionId);
  if (existing) return existing;
  const next: SessionRunState = { nextRunId: 0 };
  sessionRunStates.set(sessionId, next);
  return next;
}

async function maybePostToolTrace(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  sessionId: string,
  sessionKey: string,
  startedAtMs: number,
): Promise<void> {
  if (cfg.linearDebugToolTrace !== true) return;

  try {
    const messages = await readGatewayHistory(api, {
      sessionKey,
      limit: 250,
    });
    const activities = buildToolTraceActivities(messages, { startedAtMs });
    if (activities.length === 0) return;

    for (const activity of activities) {
      const result = await postActivity(api, cfg, sessionId, activity);
      if (!result.ok) {
        api.logger.warn?.(
          `linear runtime: tool trace publish failed session=${sessionId} status=${result.status ?? "n/a"} error=${result.error ?? "unknown"}`,
        );
        return;
      }
    }

    api.logger.info?.(
      `linear runtime: tool trace published session=${sessionId} chunks=${activities.length}`,
    );
  } catch (error) {
    api.logger.warn?.(
      `linear runtime: tool trace read failed session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function postTerminalActivity(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  trigger: LinearTrigger,
  content: ActivityContent,
): Promise<boolean> {
  if (hasRecentKey(recentTerminalKeys, trigger.eventKey)) {
    api.logger.info?.(
      `linear runtime: skipped duplicate terminal activity session=${trigger.sessionId} type=${content.type}`,
    );
    return false;
  }

  const result = await postActivity(api, cfg, trigger.sessionId, content);
  if (!result.ok) {
    api.logger.warn?.(
      `linear runtime: terminal activity publish failed session=${trigger.sessionId} type=${content.type} status=${result.status ?? "n/a"} error=${result.error ?? "unknown"}`,
    );
    return false;
  }

  api.logger.info?.(
    `linear runtime: terminal activity published session=${trigger.sessionId} type=${content.type} attempts=${result.attempts}`,
  );
  markRecentKey(recentTerminalKeys, trigger.eventKey);
  return true;
}

async function postActivity(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  sessionId: string,
  content: ActivityContent,
  opts: { ephemeral?: boolean } = {},
): Promise<ActivityPostResult> {
  const input: Record<string, unknown> = {
    agentSessionId: sessionId,
    content,
  };
  if (opts.ephemeral) input.ephemeral = true;

  let lastStatus: number | undefined;
  let lastError: string | undefined;

  for (let attempt = 0; attempt < ACTIVITY_RETRY_DELAYS_MS.length; attempt += 1) {
    const delayMs = ACTIVITY_RETRY_DELAYS_MS[attempt];
    if (delayMs > 0) await sleep(delayMs);

    const result = await callLinear(api, cfg, "agentActivityCreate", {
      query: ACTIVITY_MUTATION,
      variables: { input },
    });
    if (result.ok) {
      const root = readObject(result.data?.agentActivityCreate);
      if (root?.success === true) {
        return { ok: true, attempts: attempt + 1 };
      }
      lastError = "mutation returned success=false";
    } else {
      lastStatus = result.status;
      lastError = result.error;
    }

    if (!shouldRetryActivityPost(lastStatus, lastError, attempt)) break;
  }

  return {
    ok: false,
    status: lastStatus,
    error: lastError,
    attempts: ACTIVITY_RETRY_DELAYS_MS.length,
  };
}

function shouldRetryActivityPost(
  status: number | undefined,
  error: string | undefined,
  attempt: number,
): boolean {
  if (attempt >= ACTIVITY_RETRY_DELAYS_MS.length - 1) return false;
  if (status === 404 || status === 408 || status === 429) return true;
  if (typeof status === "number" && status >= 500) return true;
  if (!status && error) return /fetch error|timeout|tempor/i.test(error);
  return false;
}

async function updateSessionExternalUrl(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  sessionId: string,
  url: string,
  label: string,
): Promise<void> {
  const result = await callLinear(api, cfg, "agentSessionUpdate", {
    query: SESSION_UPDATE_MUTATION,
    variables: {
      id: sessionId,
      input: { addedExternalUrls: [{ label, url }] },
    },
  });
  if (!result.ok) {
    api.logger.warn?.("linear runtime: agentSessionUpdate failed");
  }
}

function resolveExternalUrl(
  cfg: PluginConfig,
  trigger: LinearTrigger,
): { url: string; label: string } | null {
  const base = cfg.externalUrlBase?.trim();
  if (!base) return null;
  const label = cfg.externalUrlLabel?.trim() || "OpenClaw session";
  const url = buildExternalUrl(base, trigger.sessionId, trigger.issueId);
  return url ? { url, label } : null;
}

function buildExternalUrl(
  base: string,
  sessionId: string,
  issueId: string,
): string {
  const needsSession = base.includes("{session}") || base.includes("${session}");
  const needsIssue = base.includes("{issue}") || base.includes("${issue}");
  if (needsSession && !sessionId) return "";
  if (needsIssue && !issueId) return "";
  if (needsSession || needsIssue) {
    return base
      .replaceAll("{session}", sessionId)
      .replaceAll("${session}", sessionId)
      .replaceAll("{issue}", issueId)
      .replaceAll("${issue}", issueId);
  }
  if (!URL.canParse(base)) return "";
  const url = new URL(base);
  url.searchParams.set("session", sessionId);
  if (issueId) url.searchParams.set("issue", issueId);
  return url.toString();
}

function buildOpenClawSessionKey(agentId: string, linearSessionId: string): string {
  return `agent:${agentId}:linear:session:${linearSessionId}`;
}

function buildLabel(trigger: LinearTrigger): string {
  if (trigger.issueIdentifier && trigger.issueTitle) {
    return `Linear ${trigger.issueIdentifier} ${trigger.issueTitle}`.slice(0, 80);
  }
  if (trigger.issueIdentifier) return `Linear ${trigger.issueIdentifier}`;
  if (trigger.issueTitle) return `Linear ${trigger.issueTitle}`.slice(0, 80);
  return "Linear";
}

function buildThinkingText(trigger: LinearTrigger): string {
  if (trigger.action === "created") {
    return "Received the Linear session. Thinking now.";
  }
  return "Received your follow-up. Thinking now.";
}

function buildStopText(trigger: LinearTrigger): string {
  const target = `${trigger.issueIdentifier} ${trigger.issueTitle}`.trim();
  if (target) {
    return `Stop request received. I will not continue the current run for ${target}.`;
  }
  return "Stop request received. I will not continue the current run.";
}

function safePreview(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
  } catch {
    return String(value);
  }
}

function hasRecentKey(store: Map<string, number>, key: string): boolean {
  pruneRecentKeys(store);
  return typeof store.get(key) === "number";
}

function markRecentKey(store: Map<string, number>, key: string): void {
  pruneRecentKeys(store);
  store.set(key, Date.now());
}

function pruneRecentKeys(store: Map<string, number>): void {
  const cutoff = Date.now() - RECENT_KEY_TTL_MS;
  for (const [key, timestamp] of store.entries()) {
    if (timestamp < cutoff) store.delete(key);
  }
}
