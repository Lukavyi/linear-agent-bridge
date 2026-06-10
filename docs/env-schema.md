# Environment schema

The bridge is one codebase deployed twice; the `BACKEND` env var picks which
backend a deployment talks to (`openclaw` | `hermes`). This page lists every
environment variable the runtime reads, which `BACKEND` it applies to, and
whether it is required.

## How env is consumed

There are two paths:

- **`server.ts → buildPluginConfig()`** maps `UPPER_SNAKE_CASE` env vars to the
  plugin config object (`normalizeCfg` in `src/config.ts`). This is what the
  standalone Hermes deployment uses.
- **The Hermes gateway reads a few vars straight from `process.env`** at startup
  (`BACKEND`, `HERMES_URL`, `HERMES_API_KEY`, `HERMES_MODEL`) — see
  `src/runtime/backend.ts` and `src/runtime/hermes-gateway.ts`.

`PLUGIN_CONFIG_JSON` (optional) is a JSON blob used as a base; explicit env keys
override it.

## Backend selection

| Var       | Applies to | Required | Default    | Notes |
|-----------|-----------|----------|------------|-------|
| `BACKEND` | both      | no       | `openclaw` | `openclaw` \| `hermes`. Fails fast on any other value (`src/runtime/backend.ts`). |

## Hermes backend (`BACKEND=hermes`)

The Hermes deployment runs the Docker image directly (`node dist/server.js`); it
has no OpenClaw host.

| Var                              | Required | Default        | Notes |
|----------------------------------|----------|----------------|-------|
| `HERMES_URL`                     | **yes**  | —              | Private URL of the Hermes `api_server`, e.g. `http://hermes-agent.railway.internal:8642`. Bridge fails fast if missing. |
| `HERMES_API_KEY`                 | **yes**  | —              | Bearer token sent to Hermes. **Must equal** the Hermes service's `API_SERVER_KEY`. |
| `HERMES_MODEL`                   | no       | `hermes-agent` | OpenAI-compatible model name passed to `/v1/responses`. |
| `HERMES_CONTINUATION_STORE_PATH` | no       | next to token store | JSON file mapping a Linear session → last `response.id` (server-side memory resume). Put it on the Volume. |

## OpenClaw backend (`BACKEND=openclaw`)

The OpenClaw backend runs **as a plugin inside an OpenClaw process** — the host
supplies the gateway call surface (`callGateway`). It does **not** dial OpenClaw
over an env-configured URL. These vars only tune the turn; the host provides the
connection.

| Var                 | Required | Notes |
|---------------------|----------|-------|
| `OPENCLAW_PROVIDER` | no       | Provider override for the agent turn. |
| `OPENCLAW_MODEL`    | no       | Model override. |
| `OPENCLAW_THINKING` | no       | Thinking level (default `high`). |

## Linear (both backends)

| Var                         | Required | Notes |
|-----------------------------|----------|-------|
| `LINEAR_WEBHOOK_SECRET`     | **yes**  | HMAC-SHA256 secret for the `linear-signature` header. Each deployment has its own. |
| `LINEAR_API_KEY`            | no¹      | Personal/API token. If set, used directly for Linear GraphQL. |
| `LINEAR_OAUTH_CLIENT_ID`    | no¹      | `actor=app` OAuth client id (the @-agent identity). |
| `LINEAR_OAUTH_CLIENT_SECRET`| no¹      | OAuth client secret. |
| `LINEAR_OAUTH_REDIRECT_URI` | no¹      | OAuth callback, e.g. `https://<bridge-public-domain>/plugins/linear/oauth/callback`. |
| `LINEAR_TOKEN_STORE_PATH`   | **yes**² | Where OAuth tokens persist, e.g. `/data/linear-tokens.json`. Put it on the Volume. |
| `AGENT_ID`                  | no       | Stable agent id used to namespace session keys. |
| `LINEAR_DEBUG_TOOL_TRACE`   | no       | `true` to post a tool-trace activity (debug). |
| `DELEGATE_ON_CREATE`        | no       | `true`/`false` — issue delegate policy on session create. |
| `START_ON_CREATE`           | no       | `true`/`false` — issue start policy on session create. |
| `EXTERNAL_URL_BASE`         | no       | Template/base for the session "external URL". |
| `EXTERNAL_URL_LABEL`        | no       | Label for that external URL. |
| `REPO_BY_TEAM`              | no       | JSON map team→dir. |
| `REPO_BY_PROJECT`           | no       | JSON map project→dir. |
| `DEFAULT_DIR`               | no       | Fallback working dir. |

¹ Provide **either** `LINEAR_API_KEY` **or** the three `LINEAR_OAUTH_*` vars. An
`actor=app` agent (the @Hermes / @Clawd identity) uses the OAuth path; tokens are
exchanged via `/plugins/linear/oauth/*` and persisted to the token store.

² Required in practice for the OAuth path so tokens survive restarts. On Railway,
point it at the mounted Volume.

## Server / platform

| Var            | Required | Default | Notes |
|----------------|----------|---------|-------|
| `PORT`         | no       | `8080`  | Railway injects this; the server binds it. |
| `LINEAR_DEBUG` | no       | off     | `1`/`true` enables debug logging (redacted). |

## Worked example — the live `bridge-hermes` deployment

```
# bridge-hermes (BACKEND=hermes, public)
BACKEND=hermes
HERMES_URL=http://hermes-agent.railway.internal:8642
HERMES_API_KEY=<== hermes-agent API_SERVER_KEY>
LINEAR_WEBHOOK_SECRET=<hermes app webhook secret>
LINEAR_OAUTH_CLIENT_ID=<hermes actor=app client id>
LINEAR_OAUTH_CLIENT_SECRET=<hermes actor=app client secret>
LINEAR_OAUTH_REDIRECT_URI=https://<bridge-hermes-domain>/plugins/linear/oauth/callback
LINEAR_TOKEN_STORE_PATH=/data/linear-tokens.json
AGENT_ID=<agent id>

# hermes-agent (the runtime, PRIVATE — no public domain)
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8642
API_SERVER_KEY=<== bridge HERMES_API_KEY>
```

See `docs/runbook.md` for the full provisioning and teardown procedure.
