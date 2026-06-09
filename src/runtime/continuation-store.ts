import fs from "node:fs/promises";
import path from "node:path";

/**
 * Per-session continuation store for Hermes' Responses API.
 *
 * Hermes keeps conversation state server-side, addressed by the last
 * `response.id`. To resume the same conversation on a follow-up Linear prompt we
 * persist that id keyed by `linear_agent_session_id` and replay it as
 * `previous_response_id`. The map lives in a single JSON file on the bridge's
 * Railway Volume, so it survives restarts; distinct sessions are distinct keys,
 * so chains never cross.
 *
 * Writes are serialized per file (read-modify-write under a promise chain) so
 * two sessions finishing at once can't clobber each other's entry.
 */

interface ContinuationRecord {
  responseId: string;
  updatedAt: string;
}

type StoreFile = Record<string, ContinuationRecord>;

const cacheByPath = new Map<string, StoreFile>();
const writeChains = new Map<string, Promise<void>>();

/**
 * Resolves the store path: an explicit config value wins; otherwise a
 * `hermes-continuations.json` next to the OAuth token store (same Volume).
 */
export function resolveContinuationStorePath(
  explicit?: string,
  tokenStorePath?: string,
): string {
  if (explicit?.trim()) return explicit.trim();
  if (tokenStorePath?.trim()) {
    return path.join(path.dirname(tokenStorePath.trim()), "hermes-continuations.json");
  }
  const home = process.env.HOME?.trim() || "/home/ubuntu";
  return path.join(home, ".openclaw", "workspace", ".pi", "hermes-continuations.json");
}

/** The stored `response.id` for a Linear session, or undefined if none yet. */
export async function loadContinuation(
  filePath: string,
  sessionId: string,
): Promise<string | undefined> {
  const store = await readStore(filePath);
  return store[sessionId]?.responseId;
}

/** Persist the latest `response.id` for a Linear session. */
export async function saveContinuation(
  filePath: string,
  sessionId: string,
  responseId: string,
): Promise<void> {
  const id = responseId.trim();
  if (!sessionId || !id) return;

  const run = (writeChains.get(filePath) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const store = await readStore(filePath);
      store[sessionId] = { responseId: id, updatedAt: new Date().toISOString() };
      await writeStore(filePath, store);
    });
  writeChains.set(filePath, run);
  await run;
}

export function clearContinuationCache(filePath?: string): void {
  if (filePath) {
    cacheByPath.delete(filePath);
    return;
  }
  cacheByPath.clear();
}

async function readStore(filePath: string): Promise<StoreFile> {
  const cached = cacheByPath.get(filePath);
  if (cached) return cached;
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  const store = parseStore(raw);
  cacheByPath.set(filePath, store);
  return store;
}

async function writeStore(filePath: string, store: StoreFile): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => {});
  cacheByPath.set(filePath, store);
}

function parseStore(raw: string): StoreFile {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: StoreFile = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const responseId = (value as { responseId?: unknown }).responseId;
      if (typeof responseId !== "string" || !responseId) continue;
      const updatedAt = (value as { updatedAt?: unknown }).updatedAt;
      out[key] = {
        responseId,
        updatedAt: typeof updatedAt === "string" ? updatedAt : new Date(0).toISOString(),
      };
    }
    return out;
  } catch {
    return {};
  }
}
