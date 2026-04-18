import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeCfg } from "../config.js";
import {
  ACTIVITY_MUTATION,
  SESSION_UPDATE_MUTATION,
} from "../graphql/mutations.js";
import { AGENT_SESSION_ACTIVITIES_QUERY } from "../graphql/queries.js";
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
  readNumber,
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
import { readGatewayHistory, runGatewayTurn } from "./gateway.js";
import {
  buildExtraSystemPrompt,
  buildTurnMessage,
  type HistoryEntry,
} from "./prompt.js";
import { buildToolTraceActivities } from "./tool-trace.js";
import {
  normalizeLinearWebhookPayload,
  parseLinearTrigger,
  type LinearTrigger,
} from "./payload.js";
import {
  buildReconcilePlan,
  loadReconcileSnapshot,
  type ReconcilePlan,
  type SessionReconcileSnapshot,
} from "./reconcile.js";
import {
  isDurablyProcessedEvent,
  markDurablyProcessedEvent,
} from "./reconcile-state.js";

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
const AUTO_RECONCILE_PROMPT_DELAYS_MS = [0, 250, 1000, 2500];

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
  return async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return;
    }

    const read = await readBody(req, MAX_BODY);
    if (!read.ok) {
      sendJson(res, read.status, { ok: false, error: read.error });
      return;
    }

    const cfg = normalizeCfg(api.pluginConfig);
    const signature = readHeader(req, "linear-signature");
    if (
      cfg.linearWebhookSecret &&
      !verifySignature(cfg.linearWebhookSecret, signature, read.body)
    ) {
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(read.body.toString("utf8"));
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid JSON" });
      return;
    }

    const payload = normalizeLinearWebhookPayload(parsed);
    const delivery = readHeader(req, "linear-delivery");
    const enrichedPayload = delivery ? { ...payload, linearDelivery: delivery } : payload;
    const trigger = parseLinearTrigger(enrichedPayload);
    if (trigger?.webhookTimestamp) {
      const ageMs = Math.abs(Date.now() - trigger.webhookTimestamp);
      if (ageMs > WEBHOOK_STALE_MS) {
        res.statusCode = 401;
        res.end("Stale webhook");
        return;
      }
    }

    res.statusCode = 202;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true }));

    queueMicrotask(() => {
      processWebhook(api, cfg, enrichedPayload, trigger).catch((error) => {
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
): Promise<void> {
  const kind = readString(payload.type) ?? "";
  if (
    kind === "PermissionChange" ||
    kind === "OAuthApp" ||
    kind === "AppUserNotification"
  ) {
    api.logger.info?.(`linear runtime: ignored ${kind}`);
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
      api.logger.info?.("linear runtime: skipped self-authored Comment webhook");
      return;
    }
  }

  if (trigger) {
    rememberCommentPromptHint(trigger, payload);
  }

  if (!trigger) {
    api.logger.info?.(
      `linear runtime: ignored webhook type=${kind || "unknown"} action=${readString(payload.action) ?? ""}`,
    );
    return;
  }

  await acceptTrigger(api, cfg, payload, trigger);
}

async function acceptTrigger(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  payload: Record<string, unknown>,
  trigger: LinearTrigger,
): Promise<boolean> {
  if (shouldIgnoreNativeCommentTrigger(payload, trigger)) {
    api.logger.info?.(
      `linear runtime: ignored native comment trigger session=${trigger.sessionId} action=${trigger.action}`,
    );
    return false;
  }

  const bootstrapCommentCandidate = isBootstrapCommentCandidate(payload, trigger);
  if (trigger.action === "created") {
    if (hasFreshSessionMarker(recentBootstrapCommentRunsAt, trigger.sessionId)) {
      api.logger.info?.(
        `linear runtime: skipped created bootstrap duplicate session=${trigger.sessionId}`,
      );
      return false;
    }
    markSessionMarker(recentSessionCreatedAt, trigger.sessionId);
  } else if (bootstrapCommentCandidate) {
    if (await shouldSkipBootstrapCommentDuplicate(api, trigger.sessionId)) {
      api.logger.info?.(
        `linear runtime: skipped bootstrap comment duplicate session=${trigger.sessionId}`,
      );
      return false;
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
        api.logger.info?.(
          `linear runtime: skipped prompted duplicate session=${trigger.sessionId} source=${trigger.source}`,
        );
        return false;
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
    api.logger.info?.(`linear runtime: skipped duplicate event ${trigger.eventKey}`);
    return false;
  }
  if (await isDurablyProcessedEvent(cfg, trigger.eventKey)) {
    api.logger.info?.(`linear runtime: skipped durable duplicate event ${trigger.eventKey}`);
    return false;
  }
  markRecentKey(recentEventKeys, trigger.eventKey);

  if (trigger.signal === "stop") {
    await handleStopSignal(api, cfg, trigger);
    return true;
  }

  enqueueSessionTurn(trigger.sessionId, async () => {
    await executeTurn(api, cfg, trigger);
  });
  return true;
}

export function createLinearReconcileRoute(
  api: OpenClawPluginApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return;
    }

    const read = await readBody(req, MAX_BODY);
    if (!read.ok) {
      sendJson(res, read.status, { ok: false, error: read.error });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(read.body.toString("utf8"));
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid JSON" });
      return;
    }

    const body = readObject(parsed);
    const sessionId = readString(body?.sessionId);
    if (!sessionId) {
      sendJson(res, 400, { ok: false, error: "Missing sessionId" });
      return;
    }

    const cfg = normalizeCfg(api.pluginConfig);
    const snapshot = await loadReconcileSnapshot(api, cfg, {
      sessionId,
      includeCreated: body?.includeCreated !== false,
      limit: readNumber(body?.limit),
    });
    if (!snapshot) {
      sendJson(res, 404, { ok: false, error: "Agent session not found" });
      return;
    }

    const plan = buildReconcilePlan({
      snapshot,
      includeCreated: body?.includeCreated !== false,
      isEventProcessed: (eventKey) => hasRecentKey(recentEventKeys, eventKey),
    });

    const accepted: string[] = [];
    const skipped: string[] = [];

    if (plan.createdTrigger) {
      if (await isDurablyProcessedEvent(cfg, plan.createdTrigger.eventKey)) {
        skipped.push(plan.createdTrigger.eventKey);
      } else if (await acceptTrigger(api, cfg, {}, plan.createdTrigger)) {
        accepted.push(plan.createdTrigger.eventKey);
      } else {
        skipped.push(plan.createdTrigger.eventKey);
      }
    }

    for (const trigger of plan.promptTriggers) {
      if (await isDurablyProcessedEvent(cfg, trigger.eventKey)) {
        skipped.push(trigger.eventKey);
        continue;
      }
      if (await acceptTrigger(api, cfg, {}, trigger)) {
        accepted.push(trigger.eventKey);
      } else {
        skipped.push(trigger.eventKey);
      }
    }

    sendJson(res, 200, {
      ok: true,
      sessionId,
      status: snapshot.status,
      accepted,
      skipped,
      acceptedCount: accepted.length,
      skippedCount: skipped.length,
    });
  };
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

export function recoverTriggerFromReconcilePlan(input: {
  trigger: LinearTrigger;
  snapshot: SessionReconcileSnapshot;
  plan: ReconcilePlan;
}): LinearTrigger {
  const { trigger, snapshot, plan } = input;
  if (trigger.prompt.trim()) return trigger;

  const recoveredPromptTrigger = plan.promptTriggers.at(-1);
  if (recoveredPromptTrigger) return recoveredPromptTrigger;

  if (trigger.action !== "created") return trigger;

  const fallbackPrompt =
    snapshot.sourceComment.body.trim() ||
    snapshot.comment.body.trim();
  if (!fallbackPrompt) return trigger;

  return {
    ...trigger,
    prompt: fallbackPrompt,
    commentId:
      trigger.commentId ||
      snapshot.sourceComment.id ||
      snapshot.comment.id,
  };
}

async function hydrateTriggerPromptFromReconcile(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  trigger: LinearTrigger,
  delaysMs: number[] = AUTO_RECONCILE_PROMPT_DELAYS_MS,
): Promise<LinearTrigger> {
  if (trigger.prompt.trim()) return trigger;

  for (let index = 0; index < delaysMs.length; index += 1) {
    const delayMs = delaysMs[index] ?? 0;
    if (delayMs > 0) await sleep(delayMs);

    const snapshot = await loadReconcileSnapshot(api, cfg, {
      sessionId: trigger.sessionId,
      includeCreated: trigger.action === "created",
    });
    if (!snapshot) continue;

    const plan = buildReconcilePlan({
      snapshot,
      includeCreated: trigger.action === "created",
      isEventProcessed: (eventKey) =>
        eventKey !== trigger.eventKey && hasRecentKey(recentEventKeys, eventKey),
    });

    const filteredPromptTriggers: LinearTrigger[] = [];
    for (const candidate of plan.promptTriggers) {
      if (candidate.eventKey === trigger.eventKey) continue;
      if (await isDurablyProcessedEvent(cfg, candidate.eventKey)) continue;
      filteredPromptTriggers.push(candidate);
    }

    const recovered = recoverTriggerFromReconcilePlan({
      trigger,
      snapshot,
      plan: {
        ...plan,
        promptTriggers: filteredPromptTriggers,
      },
    });

    if (recovered.eventKey !== trigger.eventKey) {
      markRecentKey(recentEventKeys, recovered.eventKey);
    }
    if (recovered.prompt.trim()) return recovered;
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
): Promise<void> {
  let trigger = await hydrateTriggerPromptFromCommentHint(inputTrigger);
  if (!inputTrigger.prompt.trim() && trigger.prompt.trim()) {
    api.logger.info?.(
      `linear runtime: hydrated missing prompt from comment hint session=${trigger.sessionId}`,
    );
  }
  if (!trigger.prompt.trim()) {
    const recovered = await hydrateTriggerPromptFromReconcile(api, cfg, trigger);
    if (!trigger.prompt.trim() && recovered.prompt.trim()) {
      api.logger.info?.(
        `linear runtime: auto-recovered missing prompt from reconcile session=${recovered.sessionId} event=${recovered.eventKey}`,
      );
    }
    trigger = recovered;
  }
  const state = getSessionRunState(trigger.sessionId);
  const runId = state.nextRunId + 1;
  state.nextRunId = runId;
  state.activeRunId = runId;
  const agentId = cfg.agentId ?? cfg.devAgentId ?? "main";
  const sessionKey = buildOpenClawSessionKey(agentId, trigger.sessionId);
  let runStartedAtMs = Date.now();

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

    const history = await loadActivityHistory(api, cfg, trigger.sessionId);
    runStartedAtMs = Date.now();
    const result = await runGatewayTurn(api, cfg, {
      agentId,
      sessionKey,
      label: buildLabel(trigger),
      message: buildTurnMessage({ cfg, trigger, history }),
      idempotencyKey: trigger.eventKey,
      extraSystemPrompt: buildExtraSystemPrompt(),
      timeoutMs: AGENT_TIMEOUT_MS,
    });

    if (state.suppressedRunId === runId) {
      api.logger.info?.(
        `linear runtime: suppressed terminal output for stopped run session=${trigger.sessionId}`,
      );
      return;
    }

    api.logger.info?.(`linear runtime: raw gateway result ${safePreview(result)}`);
    await maybePostToolTrace(api, cfg, trigger.sessionId, sessionKey, runStartedAtMs);
    const reply = extractVisibleReply(result);
    if (!reply) {
      await postTerminalActivity(api, cfg, trigger, {
        type: "error",
        body:
          "This run finished without a visible reply. The model returned no publishable answer, so the bridge is marking the turn as failed.",
      });
      return;
    }

    await postTerminalActivity(api, cfg, trigger, {
      type: "response",
      body: reply,
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
    await postTerminalActivity(api, cfg, trigger, {
      type: "error",
      body: `Agent run failed: ${message}`,
    });
  } finally {
    if (state.activeRunId === runId) state.activeRunId = undefined;
    if (state.suppressedRunId === runId) state.suppressedRunId = undefined;
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
  await markDurableEvent(api, cfg, trigger.eventKey);
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

function extractVisibleReply(result: unknown): string {
  const root = readObject(result);
  if (!root) return "";
  const payloads = readArray(readObject(root.result)?.payloads);
  const parts: string[] = [];
  const seenMedia = new Set<string>();

  for (const entry of payloads) {
    const item = readObject(entry);
    if (!item) continue;
    const text = readString(item.text);
    if (text) parts.push(text);
    const directMedia = readString(item.mediaUrl);
    if (directMedia && !seenMedia.has(directMedia)) {
      seenMedia.add(directMedia);
      parts.push(`Media: ${directMedia}`);
    }
    const mediaUrls = readArray(item.mediaUrls);
    for (const mediaUrl of mediaUrls) {
      const value = readString(mediaUrl);
      if (value && !seenMedia.has(value)) {
        seenMedia.add(value);
        parts.push(`Media: ${value}`);
      }
    }
  }

  const reply = parts.join("\n\n").trim();
  if (!reply) return "";
  if (/\bNO_REPLY\b/i.test(reply)) return "";
  return reply;
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

async function markDurableEvent(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  eventKey: string,
): Promise<void> {
  try {
    await markDurablyProcessedEvent(cfg, eventKey);
  } catch (error) {
    api.logger.warn?.(
      `linear runtime: failed to persist processed event ${eventKey}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
