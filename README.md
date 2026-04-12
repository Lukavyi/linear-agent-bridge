# linear-agent-bridge

An OpenClaw plugin that connects Linear Agent Sessions to one persistent OpenClaw conversation.

This repo is for the plugin runtime itself. It is not a full infrastructure guide for every possible ingress setup.

## What the live plugin does

- Receives Linear Agent Session webhooks on `/plugins/linear/linear`
- Verifies webhook signatures and rejects stale payloads
- Maps one Linear `AgentSession` to one stable OpenClaw session key
- Posts a fast visible `thought` activity as an acknowledgement
- Runs one OpenClaw turn for each accepted Linear turn
- Publishes exactly one final visible `response` or `error`
- Deduplicates known duplicate webhook combinations
- Supports OAuth callback and code exchange routes for app installation
- Optionally publishes post-run tool/file trace breadcrumbs when `linearDebugToolTrace=true`

## What the live plugin does not do

- It does not register `/plugins/linear/api`
- It does not expose `/hooks/linear`
- It does not run a plugin-side Linear tool API proxy
- It does not treat Linear as a second tool runtime

Linear is treated as a conversational surface. OpenClaw remains the runtime that actually executes the agent turn.

## Registered routes

`index.ts` registers only these routes:

- `/plugins/linear/linear`
- `/plugins/linear/oauth/callback`
- `/plugins/linear/oauth/exchange`

If your public ingress uses a proxy or tunnel, it still needs to forward into those plugin routes.

## Runtime model

The active runtime lives in `src/runtime/*`.

High level flow:

1. Linear sends a webhook to `/plugins/linear/linear`.
2. The plugin validates the signature, normalizes the payload, and returns `202` quickly.
3. The plugin resolves the Linear session identity and maps it to:
   `agent:<agentId>:linear:session:<linearSessionId>`
4. The plugin posts an immediate visible `thought` activity.
5. The plugin runs one OpenClaw turn against that stable session key.
6. The plugin publishes exactly one terminal `response` or `error`.

For comment-shaped follow-ups, the runtime may resolve the session through fallback lookup logic, but the intended source of truth is the native Linear session/activity flow.

## Infrastructure shape

The plugin only requires a public HTTPS endpoint that ultimately reaches the registered plugin routes.

Direct setup:

```text
Linear
  -> public HTTPS
  -> OpenClaw
  -> /plugins/linear/linear
  -> linear-agent-bridge
```

Common proxied setup:

```text
Linear
  -> public HTTPS
  -> cloudflared
  -> optional thin proxy
  -> OpenClaw
  -> /plugins/linear/linear
  -> linear-agent-bridge
```

A proxy such as `linear-proxy` is optional. It can be useful for ingress logging, header preservation, or TLS/front-door separation, but the plugin itself does not depend on having a separate proxy layer.

## Configuration

The active config surface is defined in `openclaw.plugin.json`.

Core runtime settings:

- `agentId` - OpenClaw agent id to run, default `main`
- `devAgentId` - legacy alias for `agentId`
- `linearWebhookSecret` - required for webhook verification
- `linearApiKey` - direct Linear token for GraphQL calls
- `linearOauthClientId`
- `linearOauthClientSecret`
- `linearOauthRedirectUri`
- `linearTokenStorePath` - persisted OAuth token storage
- `openclawProvider` - provider override, default `openai`
- `openclawModel` - model override, default `gpt-5.4`
- `openclawThinking` - thinking override, default `high`
- `delegateOnCreate` - optionally auto-delegate on session create
- `startOnCreate` - optionally move issue to started on session create
- `repoByTeam` - workspace hints by Linear team
- `repoByProject` - workspace hints by Linear project
- `defaultDir` - default workspace hint when no mapping matches
- `externalUrlBase` - optional external session link template
- `externalUrlLabel` - label for the external link
- `linearDebugToolTrace` - when true, publish visible tool/file trace breadcrumbs after runs

### Compatibility note

`openclaw.plugin.json` still exposes some legacy compatibility fields so older installs do not fail validation. Those fields should not be treated as the active architecture. In particular, the current runtime does not register `/plugins/linear/api`, even if legacy config fields such as `enableAgentApi`, `apiBaseUrl`, `apiCorsOrigins`, `apiCorsAllowCredentials`, `strictAddressing`, or `mentionHandle` still appear in the schema.

## Tool trace mode

When `linearDebugToolTrace=true`, the plugin fetches recent OpenClaw chat history after a run and publishes compact Linear `thought` activities summarizing tool usage for the current turn.

Examples:

- `read ~/repo/src/runtime/handler.ts`
- `edit ~/repo/src/runtime/handler.ts`
- `web_search "linear duplicate follow-up bug" -> error: 429 rate limited`

This is for debugging and operator visibility. It is intentionally opt-in because it adds noise to Linear activity history.

## Build and test

```bash
npm run build
npm test
```

Compiled output goes to `dist/`.

## Local install

Typical local extension path:

```bash
~/.openclaw/extensions/linear-agent-bridge/
```

The plugin id remains `linear-agent-bridge`.

## Testing in Linear

1. Enable Linear Agent Session webhooks for your app.
2. Point the public webhook endpoint so it ultimately reaches `/plugins/linear/linear`.
3. Complete OAuth setup if you are using OAuth instead of a direct API token.
4. Mention or delegate the app in a Linear issue.
5. Confirm:
   - a visible `thought` appears quickly
   - only one OpenClaw run happens for the turn
   - exactly one final visible `response` or `error` is published
   - follow-up prompts continue the same conversation

## Files that matter

- `index.ts` - registers the live webhook and OAuth routes
- `src/runtime/handler.ts` - active native Linear runtime and dedupe logic
- `src/runtime/payload.ts` - webhook normalization and trigger extraction
- `src/runtime/prompt.ts` - chat-first prompt shaping
- `src/runtime/gateway.ts` - OpenClaw gateway invocation and history access
- `src/runtime/session-resolver.ts` - session lookup and fallback recovery
- `src/runtime/issue-policy.ts` - issue start/delegate policy on session create
- `src/runtime/skip-filter.ts` - self-authored and system-echo filtering
- `src/runtime/tool-trace.ts` - post-run tool/file trace summarization
- `src/runtime/validation.ts` - webhook signature validation
- `src/linear-client.ts` - Linear GraphQL client
- `src/oauth/*` - OAuth callback, exchange, refresh, and token storage
