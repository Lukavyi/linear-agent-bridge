# AGENTS.md

This file provides guidance to coding agents working in this repository.

## Overview

This is an OpenClaw plugin that bridges Linear's native Agent Session webhooks to OpenClaw agent runs. The live architecture is runtime-centered: Linear is a conversational surface, not a plugin-hosted tool API.

## Build

```bash
npm run build    # runs tsc
npm test         # builds, then runs node tests from dist/src/**/*.test.js
```

TypeScript sources in `index.ts` + `src/` compile to `dist/`.

## Architecture

### Entry point (`index.ts`)

Registers three HTTP routes via `api.registerHttpRoute`:
- `POST /plugins/linear/linear` — native Linear Agent Session webhook receiver
- `POST /plugins/linear/oauth/callback` — OAuth callback helper
- `POST /plugins/linear/oauth/exchange` — OAuth code exchange helper

No `/plugins/linear/api` route is registered.

### Module structure

```text
src/
  types.ts              — shared runtime interfaces
  config.ts             — normalizeCfg() for active plugin config
  util.ts               — HTTP/body/header/json helpers
  linear-client.ts      — callLinear() for all Linear GraphQL communication
  graphql/
    queries.ts          — GraphQL query strings
    mutations.ts        — GraphQL mutation strings
  runtime/
    handler.ts          — createLinearWebhook() and session turn execution
    payload.ts          — webhook normalization and trigger extraction
    prompt.ts           — chat-first/task-mode prompt shaping
    gateway.ts          — OpenClaw gateway invocation
    session-resolver.ts — comment webhook session lookup + fallback cache
    issue-policy.ts     — issue start/delegate policy on session create
    skip-filter.ts      — self-authored comment detection
    validation.ts       — HMAC-SHA256 signature verification
  oauth/
    route.ts            — OAuth callback/exchange route
    refresh.ts          — token refresh helper
    token-store.ts      — persisted OAuth token storage
```

### Webhook flow

1. Linear sends POST to `/plugins/linear/linear`.
2. The runtime validates the signature, rejects stale payloads, and responds `202` immediately.
3. It normalizes the native Agent Session payload and resolves the session ID for comment follow-ups when needed.
4. It posts an immediate visible `thought` activity so the user sees a fast acknowledgement.
5. It runs one OpenClaw turn against a stable session key.
6. It publishes exactly one final Linear `response` or `error`.

### Key patterns

- **callLinear()** in `linear-client.ts` — single gateway for all Linear GraphQL calls
- **Persistent session identity** — one Linear session maps to one OpenClaw session key
- **Immediate visible ack** — `runtime/handler.ts` posts a visible `thought` before the agent turn completes
- **Session ID resolution** — direct field first, then fallback lookup for comment webhooks
- **No plugin-side API proxy** — do not reintroduce `/plugins/linear/api` unless the product direction changes

### Configuration

Defined in `openclaw.plugin.json`. Active runtime options:
- `agentId` / `devAgentId`
- `linearWebhookSecret`
- `linearApiKey` or OAuth credentials + `linearTokenStorePath`
- `openclawProvider` / `openclawModel` / `openclawThinking`
- `linearDebugToolTrace`
- `repoByTeam` / `repoByProject` / `defaultDir`
- `delegateOnCreate` / `startOnCreate`
- `externalUrlBase` / `externalUrlLabel`

`openclaw.plugin.json` may still expose a few `[legacy]` compatibility fields for older installs, but the runtime ignores them. In particular, `/plugins/linear/api` is not part of the live runtime.
