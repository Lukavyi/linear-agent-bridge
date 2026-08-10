# Agent-to-agent handoff through fresh Linear Agent Sessions

Status: decision from FLOW-730, based on a live Linear experiment on 2026-08-10.

## Decision

Use a recipient-owned HTTP endpoint to open every handoff session.

The endpoint records the handoff brief in a root Linear comment, then calls `agentSessionCreateOnComment` with the recipient app's own `actor=app` OAuth token. Dev and verify call each other's endpoints instead of moving `Issue.delegate` back and forth.

Do not depend on app-authored `@mention` or re-delegation for the dev↔verify loop. The exact app-authored comment-mention path remains undocumented, while the live re-delegation test did not create a fresh session when control returned to the first agent.

## Live experiment

The disposable issue was `FLOW-738` in the `Workflow & AI` team.

| Time (Europe/Warsaw) | Action | Observed sessions |
| --- | --- | --- |
| 12:53 | An app-created issue description contained a rich-text mention of `plan`; no delegate was set. | No Agent Session appeared. This tests a description mention, not the exact `commentCreate` case. |
| 13:24 | The issue was delegated to `plan`. | A new active `plan` session appeared. |
| 13:27 | The issue was delegated from `plan` to `dev`. | A separate new `dev` session appeared. |
| 13:27 | The issue was delegated from `dev` back to `plan`. | No second `plan` session appeared. The original `plan` session remained the only one. |

### Interpretation

- Delegating to a different agent creates that agent's first session on the issue.
- Re-delegating A→B→A is not a reliable fresh-session trigger.
- The description-mention control produced no session before delegation.
- The exact `commentCreate` + app-authored mention experiment was not available through the current app write surface. Linear does not document actor-specific mention behavior, so this path stays unproven and is not the selected mechanism.
- Session activities generated during the experiment incorrectly attributed delegation-created sessions to the earlier mention. Session timestamps and the before/after session listing provide the causal evidence.

## Why the recipient must create its own session

Linear exposes two public proactive session mutations:

```graphql
mutation CreateSessionOnIssue($issueId: String!) {
  agentSessionCreateOnIssue(input: { issueId: $issueId }) {
    success
    agentSession { id }
  }
}

mutation CreateSessionOnComment($commentId: String!) {
  agentSessionCreateOnComment(input: { commentId: $commentId }) {
    success
    agentSession { id }
  }
}
```

Neither public input accepts an app user ID. The app identity therefore comes from the caller's OAuth token. Linear's broader `agentSessionCreate` mutation has an `appUserId`, but the schema marks that mutation internal.

`agentSessionCreateOnIssue` has no brief field. A public `prompt` activity is also not a documented app-authored input path. Creating a root comment first and opening the session on that comment keeps the handoff brief in the supported Linear context model.

Schema references, pinned to Linear SDK commit `eabc85d0df87617b4647e56d2f236e60bc2ed117`:

- [`AgentSessionCreateOnComment` and `AgentSessionCreateOnIssue` inputs](https://github.com/linear/linear/blob/eabc85d0df87617b4647e56d2f236e60bc2ed117/packages/sdk/src/schema.graphql#L919-L953)
- [public proactive session mutations](https://github.com/linear/linear/blob/eabc85d0df87617b4647e56d2f236e60bc2ed117/packages/sdk/src/schema.graphql#L22462-L22478)
- [`CommentCreateInput` issue, body, and parent fields](https://github.com/linear/linear/blob/eabc85d0df87617b4647e56d2f236e60bc2ed117/packages/sdk/src/schema.graphql#L5281-L5333)
- [`IssueUpdateInput.delegateId`](https://github.com/linear/linear/blob/eabc85d0df87617b4647e56d2f236e60bc2ed117/packages/sdk/src/schema.graphql#L21509-L21527)
- [Linear agent interaction documentation](https://linear.app/developers/agent-interaction)
- [Linear OAuth actor authorization](https://linear.app/developers/oauth-actor-authorization)

## Endpoint contract

Each agent app exposes the same internal route:

```http
POST /internal/linear-agent-sessions/open
Content-Type: application/json
X-Agent-Handoff-Id: <uuid>
X-Agent-Handoff-Timestamp: <unix-seconds>
X-Agent-Handoff-Signature: v1=<hex-hmac-sha256>
```

Request body:

```json
{
  "issueId": "FLOW-730",
  "brief": "Review the ready PR, wait for bot findings, and fix actionable feedback.",
  "sourceAgent": "dev",
  "sourceSessionId": "linear-session-id"
}
```

Only `issueId` and `brief` are required. The source fields are diagnostic metadata.

Successful response:

```json
{
  "ok": true,
  "commentId": "...",
  "agentSessionId": "...",
  "duplicate": false
}
```

## Request processing

1. Read the raw request body.
2. Verify `HMAC-SHA256(secret, timestamp + "." + handoffId + "." + rawBody)` with a timing-safe comparison.
3. Reject timestamps outside a five-minute window.
4. Use `X-Agent-Handoff-Id` as an idempotency key. Return the stored result for a duplicate.
5. Validate `issueId`, a non-empty bounded `brief`, and an allowlisted `sourceAgent` when present.
6. Create a root comment with the recipient's `actor=app` token. Include the brief and source metadata, but no agent mention.
7. Call `agentSessionCreateOnComment` with that comment ID using the same recipient token.
8. Persist the idempotency result before returning `202`.

If the brief already exists in Linear, the endpoint may call `agentSessionCreateOnIssue` directly. The comment-backed variant is the default because it preserves the exact handoff instruction that opened the fresh session.

## Authentication and secret handling

- Provision one random shared handoff secret to the dev and verify services.
- Store it only in each service's secret environment, never in Linear, logs, prompts, or request metadata.
- Do not share either app's Linear OAuth token with the other app.
- Rotate the shared secret independently of Linear OAuth credentials.
- Log only the handoff ID, source agent, issue identifier, result IDs, and validation outcome.

HMAC authentication gives payload integrity and peer authentication. The timestamp and idempotency key prevent replay and duplicate session creation.

## Handoff sequence

```text
dev finishes ready PR
  -> POST verify /internal/linear-agent-sessions/open
  -> verify app creates a brief comment with its own Linear token
  -> verify app opens its own fresh session on that comment
  -> verify reviews and fixes

large rework needed
  -> POST dev /internal/linear-agent-sessions/open
  -> dev app creates a rework brief comment with its own Linear token
  -> dev app opens a new fresh session on that comment
```

`Issue.delegate` may still represent the current owner for UI purposes, but it is not the session-start transport.

## Follow-up implementation scope

A separate implementation should add:

- the authenticated route and HMAC verifier;
- idempotency storage with expiry;
- `commentCreate` and `agentSessionCreateOnComment` GraphQL operations;
- integration tests for valid, stale, tampered, duplicate, and Linear-error requests;
- deployment-specific secret provisioning between dev and verify apps.
