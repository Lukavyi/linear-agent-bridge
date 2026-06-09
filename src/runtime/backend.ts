import type { OpenClawPluginApi } from "../types.js";
import type { BackendName, Gateway } from "./gateway-types.js";
import { createOpenClawGateway } from "./openclaw-gateway.js";

const DEFAULT_BACKEND: BackendName = "openclaw";
const KNOWN_BACKENDS: readonly BackendName[] = ["openclaw", "hermes"];

/**
 * Resolves the configured backend from the `BACKEND` env var.
 *
 * Defaults to `openclaw` when unset/empty and fails fast on any value outside
 * the known set. Recognized values are `openclaw` and `hermes`.
 */
export function selectBackend(
  env: NodeJS.ProcessEnv = process.env,
): BackendName {
  const raw = (env.BACKEND ?? "").trim().toLowerCase();
  if (!raw) return DEFAULT_BACKEND;
  if ((KNOWN_BACKENDS as readonly string[]).includes(raw)) {
    return raw as BackendName;
  }
  throw new Error(
    `Unknown BACKEND "${raw}". Expected one of: ${KNOWN_BACKENDS.join(", ")}.`,
  );
}

/**
 * Backend selector: returns the `Gateway` to inject into the runtime handler.
 *
 * A single switch on the resolved backend. Defaults to `openclaw`; throws on an
 * unknown value (via `selectBackend`) and on a known-but-unimplemented backend.
 * The switch is the one place to register a new backend's gateway.
 */
export function createGateway(
  _api: OpenClawPluginApi,
  backend: BackendName = selectBackend(),
): Gateway {
  switch (backend) {
    case "openclaw":
      return createOpenClawGateway();
    case "hermes":
      throw new Error(
        'BACKEND="hermes" is selected but the Hermes gateway is not implemented yet.',
      );
    default: {
      const exhaustive: never = backend;
      throw new Error(`Unhandled backend: ${String(exhaustive)}`);
    }
  }
}
