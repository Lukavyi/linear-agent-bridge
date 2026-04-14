import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginConfig } from "../types.js";
import { readNumber, readObject } from "../util.js";

const STATE_FILE_NAME = "linear-agent-bridge-state.json";
const STATE_VERSION = 1;
const STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface DurableState {
  version: number;
  processedEventKeys: Record<string, number>;
}

const cache = new Map<string, DurableState>();
const pendingLoads = new Map<string, Promise<DurableState>>();
const writeQueues = new Map<string, Promise<void>>();

export function resolveReconcileStatePath(cfg: PluginConfig): string {
  const explicit = cfg.reconcileStatePath?.trim();
  if (explicit) return explicit;

  const tokenStorePath = cfg.linearTokenStorePath?.trim();
  if (tokenStorePath) {
    return path.join(path.dirname(tokenStorePath), STATE_FILE_NAME);
  }

  return path.join(os.homedir(), ".openclaw", STATE_FILE_NAME);
}

export async function isDurablyProcessedEvent(
  cfg: PluginConfig,
  eventKey: string,
): Promise<boolean> {
  if (!eventKey) return false;
  const state = await loadState(resolveReconcileStatePath(cfg));
  pruneState(state);
  return typeof state.processedEventKeys[eventKey] === "number";
}

export async function markDurablyProcessedEvent(
  cfg: PluginConfig,
  eventKey: string,
): Promise<void> {
  if (!eventKey) return;
  const targetPath = resolveReconcileStatePath(cfg);
  const state = await loadState(targetPath);
  state.processedEventKeys[eventKey] = Date.now();
  pruneState(state);
  await queueSave(targetPath, state);
}

export function resetDurableStateForTests(): void {
  cache.clear();
  pendingLoads.clear();
  writeQueues.clear();
}

async function loadState(targetPath: string): Promise<DurableState> {
  const cached = cache.get(targetPath);
  if (cached) return cached;

  const pending = pendingLoads.get(targetPath);
  if (pending) return pending;

  const load = (async () => {
    const next = await readStateFile(targetPath);
    cache.set(targetPath, next);
    pendingLoads.delete(targetPath);
    return next;
  })();

  pendingLoads.set(targetPath, load);
  return load;
}

async function readStateFile(targetPath: string): Promise<DurableState> {
  const fallback = createEmptyState();
  const raw = await readFile(targetPath, "utf8").catch(() => "");
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw) as unknown;
    const root = readObject(parsed);
    const processed = readObject(root?.processedEventKeys);
    if (!root || readNumber(root.version) !== STATE_VERSION || !processed) {
      return fallback;
    }

    const normalized: Record<string, number> = {};
    for (const [key, value] of Object.entries(processed)) {
      const timestamp = readNumber(value);
      if (!timestamp || timestamp <= 0) continue;
      normalized[key] = timestamp;
    }

    const state: DurableState = {
      version: STATE_VERSION,
      processedEventKeys: normalized,
    };
    pruneState(state);
    return state;
  } catch {
    return fallback;
  }
}

function createEmptyState(): DurableState {
  return {
    version: STATE_VERSION,
    processedEventKeys: {},
  };
}

function pruneState(state: DurableState): void {
  const cutoff = Date.now() - STATE_RETENTION_MS;
  for (const [key, timestamp] of Object.entries(state.processedEventKeys)) {
    if (timestamp < cutoff) delete state.processedEventKeys[key];
  }
}

async function queueSave(targetPath: string, state: DurableState): Promise<void> {
  cache.set(targetPath, state);
  const previous = writeQueues.get(targetPath) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await mkdir(path.dirname(targetPath), { recursive: true });
      const tempPath = `${targetPath}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(tempPath, targetPath);
    })
    .finally(() => {
      if (writeQueues.get(targetPath) === next) {
        writeQueues.delete(targetPath);
      }
    });
  writeQueues.set(targetPath, next);
  await next;
}
