# Runbook — dual-deploy on Railway

Operating model for running the bridge twice in one Railway project: one
deployment per backend, each with its own Linear `actor=app` OAuth app, its own
webhook secret, and its own token-store Volume. The backend runtimes
(`hermes-agent`, and OpenClaw) stay on the **private** network only.

```
                         PUBLIC INTERNET
                               │  POST /plugins/linear/linear (HTTPS + HMAC)
            ┌──────────────────┴──────────────────┐
            ▼                                      ▼
   ┌────────────────────┐               ┌────────────────────┐
   │   bridge-clawd     │  PUBLIC ✓     │   bridge-hermes    │  PUBLIC ✓
   │   BACKEND=openclaw │               │   BACKEND=hermes   │
   │   Volume: /data    │               │   Volume: /data    │
   └─────────┬──────────┘               └─────────┬──────────┘
             │ railway.internal + Bearer          │ railway.internal + Bearer
             ▼                                     ▼
   ┌────────────────────┐               ┌────────────────────┐
   │     openclaw       │  PRIVATE ✗    │    hermes-agent    │  PRIVATE ✗
   │  (no public domain)│               │  (no public domain)│
   └────────────────────┘               └────────────────────┘
```

Status as of this writing: the **hermes side is live and verified**
(`bridge-hermes` + `hermes-agent` in the `hermes` Railway project). The
`bridge-clawd` + `openclaw` side is the open item tracked by BRIDGE-21; @Clawd
still runs via the homelab ingress until that cutover.

## 1. The two OAuth apps (one per agent identity)

Linear binds **one** bot identity per OAuth app, so each bridge needs its own
`actor=app` OAuth application. Do this once per agent (@Hermes, @Clawd):

1. Linear → **Settings → API → OAuth applications → New**.
2. Set the app to act **as the app** (`actor=app`) so it appears as a distinct
   agent (@Hermes) that can be @-mentioned.
3. Redirect URI: `https://<bridge-public-domain>/plugins/linear/oauth/callback`.
4. Grant the agent/app scopes needed for Agent Sessions and comments.
5. Configure the webhook to point at `https://<bridge-public-domain>/plugins/linear/linear`
   and copy the **signing secret** → the bridge's `LINEAR_WEBHOOK_SECRET`.
6. Copy client id/secret → `LINEAR_OAUTH_CLIENT_ID` / `LINEAR_OAUTH_CLIENT_SECRET`.
7. Install/authorize the app in the workspace, then complete the token exchange
   via the bridge's `/plugins/linear/oauth/*` routes. The resulting tokens land
   in `LINEAR_TOKEN_STORE_PATH` on the Volume.

Keep the two apps fully separate — separate secrets, separate token stores. A
failure or teardown on one side must never touch the other.

## 2. Per-service Railway settings

### Backend runtime (`hermes-agent`, and `openclaw`) — PRIVATE

- **Public networking: OFF.** No `*.railway.app` domain assigned; only
  `*.railway.internal` is reachable from sibling services. This is the primary
  control keeping the LLM runtime off the public internet — verify the service
  has **no public domain**.
- For Hermes, the `api_server` must require a key: set `API_SERVER_KEY`,
  `API_SERVER_HOST=0.0.0.0`, `API_SERVER_PORT` (e.g. `8642`),
  `API_SERVER_ENABLED=true`.
- Mount a data Volume for the runtime's own state.

### Bridge (`bridge-hermes`, `bridge-clawd`) — PUBLIC

- **Public networking: ON** — Linear must reach `/plugins/linear/linear` over
  HTTPS. Railway terminates TLS.
- Mount a **Volume** (e.g. at `/data`) and set `LINEAR_TOKEN_STORE_PATH` under
  it (e.g. `/data/linear-tokens.json`). For Hermes also keep
  `HERMES_CONTINUATION_STORE_PATH` on the same Volume (defaults beside the token
  store).
- Set the env per `docs/env-schema.md`. Build is the repo `Dockerfile`; start is
  `node dist/server.js`; healthcheck path is `/health` (`railway.json`).

## 3. Private networking + Bearer pairing

- The bridge reaches its runtime via the runtime's private domain:
  `HERMES_URL=http://hermes-agent.railway.internal:<API_SERVER_PORT>`.
- **`HERMES_API_KEY` on the bridge must equal `API_SERVER_KEY` on the runtime.**
  Hermes refuses to bind non-localhost without a key, so a misconfiguration
  fails closed rather than exposing an unauthenticated runtime.
- Quick check (mask values): compare the two secrets' hashes, e.g.
  `railway variables -s bridge-hermes --kv | grep HERMES_API_KEY` vs
  `railway variables -s hermes-agent --kv | grep API_SERVER_KEY`.

## 4. OAuth tokens at rest

OAuth tokens are persisted by `src/oauth/token-store.ts` as JSON at
`LINEAR_TOKEN_STORE_PATH`, written with file mode `0600` inside a `0700`
directory, on a **private Railway Volume** that no public service can reach.

**Decision (accepted):** tokens are protected at rest by filesystem permissions
(`0600`) plus Volume isolation, **not** by application-level encryption. This
matches the PRD's "token-store retained as-is" scope: for a single-tenant
deployment on a private Volume, app-side encryption would add key-management
overhead without a meaningful threat-model gain. If the threat model changes
(shared Volume, multi-tenant, exportable backups), revisit by adding encryption
in `token-store.ts`.

## 5. Verify a deployment is healthy

- `curl https://<bridge-public-domain>/health` → `{"ok":true,"service":"linear-agent-bridge"}`.
- @-mention the agent in a Linear issue; in the bridge logs a single correlation
  id should trace `webhook_received → signature_verified → turn_started →
  turn_completed` (`railway logs -s <bridge-service>`). HMAC is active when you
  see `signed=1` and `phase=signature_verified`.

## 6. One-click teardown — remove one side without touching the other

To retire **@Hermes** (or @Clawd) cleanly, in this order:

1. In Linear, **disable/delete that agent's OAuth app** (and its webhook) so no
   further webhooks are sent. The other agent's app is untouched.
2. In Railway, **delete the `bridge-hermes` service** (its Volume holds only that
   agent's tokens + continuation store — removing it discards exactly that
   agent's state).
3. If the runtime is dedicated to that agent, **delete `hermes-agent`** too.
   Leave any shared runtime alone.
4. Confirm the surviving agent still works: `/health` + a live @-mention trace.

Because the two sides share no secret, no Volume, and no OAuth app, deleting one
cannot affect the other's identity, tokens, or sessions.

## 7. Webhook rollback note

The Linear webhook URL is the single switch for where an agent's events go. To
roll an agent **back** to a previous ingress (e.g. if a Railway path regresses),
edit that agent's OAuth-app webhook URL back to the prior endpoint in Linear —
no redeploy needed. Keep the old endpoint warm until a verification window on the
new path passes (watch the new correlation-id logs for live traffic before
tearing the old path down). This is the rollback lever for the BRIDGE-21 @Clawd
cutover.
