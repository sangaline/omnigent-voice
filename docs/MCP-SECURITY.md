# Remote Omnigent MCP security gate

Status: design only. The deployed voice process has no Service or Ingress, its
coordinator MCP transport is in-process, and the standalone MCP entry point is
stdio-only. This document does not authorize a network listener.

## Security posture

Coordinator write tools are delegated remote-code-execution authority. A caller
can steer coding agents that can read private workspaces, run commands, access
runtime credentials, and communicate externally. GitHub login proves an
identity; it does not by itself authorize any coordinator operation.

Remote MCP must fail closed unless every layer below is present:

1. TLS and standards-compliant OAuth discovery and authorization.
2. An exact allowed human principal, represented by stable OIDC issuer and
   subject claims. A GitHub login name is retained for display and audit but is
   not the sole authorization key because login names can change or be reused.
3. Audience-, client-, and scope-bound access tokens with online revocation.
4. Omnigent session ACL checks on every read and write after authentication.
5. Server-side restrictions on the agents, hosts, and workspaces that a remote
   caller may launch.
6. Per-principal event filtering, cursor state, action attribution, and private
   audit logs.

The allowed issuer, stable subject, and human-readable login belong in private
runtime configuration. An absent allowlist disables remote MCP rather than
admitting every valid GitHub or organization member.

## Shared semantic core

Authentication and transport adapters must call one coordinator service rather
than reimplementing tool behavior. Every operation receives an authenticated
principal, client identity, explicit target, and correlation identifier. The
core performs authorization and returns typed state, action receipts, and event
cursors.

The voice adapter may retain its private focus stack and deterministic name
routing because it authenticates one allowed Discord caller. Remote MCP must not
share an implicit focus across chats or clients. Remote writes carry an explicit
session target; a convenience focus is scoped to one authenticated MCP context
and never becomes authority for another context.

The common event contract is a durable, monotonically ordered replay stream:

- `get_updates(after_event_id)` returns immediately.
- A bounded `wait_for_updates` may hold an active request until a real event or
  timeout.
- MCP resource-change notifications are advisory hints to refetch; they contain
  no sensitive session payload.
- A Claude Code Channels adapter may turn the same authorized event into a
  proactive local Claude turn.
- Voice can subscribe directly and wake Celeris without invoking the model for
  empty polls.

Every fetch rechecks current ACLs. A cursor must not reveal or drain another
principal's events, and reconnecting clients must have explicit expiry and
bounded replay behavior.

## Authorization surface

Scopes are deliberately separated even for an initial single-user deployment.

| Capability | Required scope | Additional enforcement |
| --- | --- | --- |
| List/read sessions and output | `omnigent.read` | Session view permission; redact inaccessible relationships |
| Read updates or wait for events | `omnigent.read` | Filter before enqueue and again before return |
| Send or queue a message | `omnigent.execute` | Explicit target and edit permission; exact receipt |
| Start a session | `omnigent.execute` | Server allowlists agent, host, and workspace; no arbitrary path |
| Rename or archive | `omnigent.manage` | Explicit target and sufficient session permission |
| Resolve a structured prompt | `omnigent.approve` | Exact pending prompt and target; deliberate client confirmation |

`send_message` is an execution capability, not harmless chat. Prompt resolution
is separate because it may approve tools or other consequential actions. MCP
tool annotations should help clients request confirmation, but server-side
authorization never relies on a client honoring annotations.

## OAuth requirements

The remote resource should reuse Omnigent's existing GitHub-through-OIDC login
and user mapping while exposing the standard MCP OAuth surface:

- RFC 9728 protected-resource metadata for the exact MCP resource URI.
- Authorization-server metadata, authorization-code flow, and PKCE S256.
- Strict dynamic-client registration or pre-registered clients. Redirect URIs
  are exact HTTPS or loopback values with no fragments or wildcards.
- An explicit consent screen showing client and requested scopes. An existing
  Omnigent browser cookie must not silently grant a newly registered client
  execution authority.
- Short-lived access tokens, audience-bound to the MCP resource, plus rotating
  refresh tokens with reuse detection. Server-side token records make logout,
  client revocation, and emergency principal revocation effective.
- Bearer authentication on the MCP transport. Browser session cookies are not
  accepted by tool endpoints, avoiding ambient-cookie authorization and CSRF.

Tokens, authorization codes, client secrets, and raw headers must never enter
application logs. Rate limits apply to registration, authorization, token, and
tool endpoints. Request sizes, tool argument sizes, concurrency, and bounded
wait duration are capped.

## Audit and incident controls

Every tool attempt records the stable principal, display login, OAuth client,
scope decision, operation, explicit session target, outcome, correlation ID,
and timestamp. Exact message or output content remains in sensitive private
storage with the existing retention policy; routine security logs use bounded
summaries and never contain credentials.

Remote MCP has an independent kill switch that unmounts the transport and OAuth
routes. Revoking a principal or client must invalidate refresh grants
immediately and bound existing access to the short access-token lifetime. The
deployment must remain removable without affecting Omnigent session data or the
private voice adapter.

## Required security tests before exposure

- Unauthenticated requests receive a standards-compliant challenge and no data.
- A valid but unallowlisted GitHub/OIDC principal receives no session metadata.
- Wrong issuer, audience, client, scope, expiration, or signature is rejected.
- Read-only tokens cannot send, start, archive, rename, or answer prompts.
- A valid caller cannot read or mutate a session lacking the required ACL.
- Focus and event cursors cannot cross OAuth clients, MCP contexts, or users.
- Event notifications never contain unauthorized payload and refetch rechecks
  authorization after an ACL change.
- Arbitrary host, agent, and workspace values fail before a session is created.
- Redirect manipulation, authorization-code replay, refresh-token replay, CSRF,
  and silent-consent attempts fail.
- Token and tool logs contain attribution but no credentials or raw headers.
- A live external test verifies TLS, discovery, OAuth, revocation, reconnect,
  rate limits, and the remote kill switch before write scopes are enabled.

No remote endpoint should be deployed until these tests are automated and the
rendered Kubernetes resources have been reviewed for unintended routes.
