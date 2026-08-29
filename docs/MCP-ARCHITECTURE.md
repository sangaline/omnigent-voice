# Authenticated Omnigent MCP architecture

Status: proposed design. It does not enable a network transport. Security
requirements in `MCP-SECURITY.md` remain the release gate.

## Outcome

Expose a remote MCP resource at:

```text
https://<omnigent-host>/mcp/
```

Claude's remote connector reaches this URL from Anthropic's cloud, including
when the user chats from a mobile client. The URL must therefore be publicly
reachable over TLS; private cluster reachability is not sufficient.

The remote gateway becomes the account-scoped semantic boundary. The existing
voice implementation remains in-process for the auth-first milestone, then
moves onto the same semantic operations once the remote contract is proven.
Adapters may present different schemas or event delivery mechanisms, but they
must not duplicate session permissions, action semantics, or cursor logic.

```text
Omnigent API + permission system
              |
  per-user delegated Omnigent grant
              |
      MCP gateway semantic core
        /            |                 \
voice adapter   remote MCP adapter   Claude channel adapter
active events   OAuth + HTTP         local stdio extension
```

## Deployment boundary

The implementation reuses the credential-free `omnigent-voice` image with a
separate `mcp:remote` entrypoint and dedicated MCP gateway Deployment. It is not
the Discord voice pod. Traefik path routing sends `/mcp`, `/mcp/oauth/*`, the
standard OAuth endpoints, and the exact matching well-known discovery paths to
that Service. Every other path on the existing host continues to the upstream
Omnigent Service. This avoids another image while retaining an independent pod,
PVC, resource policy, restart boundary, and ingress kill switch.

The gateway does not hold a global Omnigent service credential and never sends
an `X-User` or equivalent impersonation header. During MCP authorization it
drives Omnigent's existing CLI/OIDC ticket flow. Omnigent authenticates the
GitHub user, resolves its own account, and returns a per-user refresh grant to
the gateway over the private service route. Every later gateway call uses that
delegated grant, so the upstream API applies its ordinary ownership and session
ACL checks as the actual user.

The gateway stores each upstream refresh grant encrypted and only alongside the
corresponding MCP grant. It rotates the encrypted value when Omnigent rotates
the grant and revokes it when the MCP connection is revoked. Compromise of one
grant must not yield a credential for another account, and there is no
server-wide fallback credential.

One small hash-guarded upstream patch is expected: CLI-ticket login must honor
the already-sanitized same-origin `return_to` after fulfilling the ticket, and
the one-time poll result must include the stable OIDC subject associated with
the returned Omnigent `user_id`. The MCP and OAuth implementation itself does
not live in the upstream source tree.

## Identity and account linkage

GitHub authenticates through the existing OIDC provider. Authorization uses an
immutable external-identity record:

```text
(issuer, subject) -> omnigent_account_id
                      + display login
                      + last verified email
```

The stable issuer/subject pair is authoritative. GitHub login and email remain
useful display and audit fields but cannot silently transfer session ownership
when renamed or reassigned. The initial link is created only from Omnigent's
one-time CLI-ticket result after Omnigent itself completes OIDC and returns both
its canonical account identifier and immutable OIDC subject. A later login that
presents the same subject with a different Omnigent account, or the same account
with a different subject, fails closed and requires an operator-reviewed
migration.

An MCP authorization succeeds only for an active account admitted by Omnigent's
normal account policy. Each issued token carries the Omnigent account identifier
as its effective subject plus the exact MCP audience, OAuth client, and granted
scopes. Adding another Omnigent user therefore enables a separate delegated MCP
connection without granting access to the first user's sessions.

Every coordinator operation receives the resolved account and uses Omnigent's
existing permission store:

- Session lists contain only accessible sessions.
- Reads, updates, pending prompts, and action receipts are filtered by view
  permission.
- Sends and lifecycle changes require the corresponding edit or owner level.
- New sessions are owned by the authenticated account and may use only that
  account's eligible host/workspace configuration.
- Administrative status never implies cross-account MCP visibility unless a
  separately granted administrative tool and scope are deliberately designed.

## OAuth flow

1. The MCP client requests `/mcp/` and receives a `401` challenge pointing to
   RFC 9728 protected-resource metadata.
2. Metadata identifies the authorization server and exact MCP resource URI.
3. The client dynamically registers with strict redirect validation, or uses a
   pre-registered client.
4. `/authorize` creates a one-time gateway transaction and requests an internal
   Omnigent CLI-login ticket with a sanitized same-origin gateway callback.
5. The browser completes Omnigent's ordinary GitHub/OIDC login. Omnigent binds
   the ticket to its canonical account and immutable OIDC subject, then redirects
   back without placing the ticket or grant in a browser-visible URL.
6. The gateway polls the ticket once over the private service route and stores
   the returned per-user Omnigent refresh grant encrypted at rest.
7. An explicit consent page identifies the client and requested scopes. The
   initial release permits only `omnigent.read`.
8. The client exchanges a one-time code with PKCE for a short opaque access
   token and rotating refresh token. Only hashes of gateway tokens are stored.
9. Every Streamable HTTP request verifies token status, audience, client, scope,
   active identity link, and then relies on the delegated Omnigent access token
   for the upstream account/session ACL check.

The authorization transaction, client registrations, grants, token hashes, and
refresh-family reuse state are durable database records. Disconnecting the
Claude connector or revoking it in Omnigent invalidates its grant.

The initial store is Node's built-in SQLite on a private PVC. OAuth access,
refresh, authorization-code, and transaction secrets are stored only as
SHA-256 digests. Omnigent tickets and per-user refresh grants use AES-256-GCM
with record-specific associated data; the 32-byte encryption key exists only in
a runtime Secret. One gateway replica owns the database and serializes refresh
rotation.

## Semantic coordinator API

The core takes explicit typed requests rather than MCP-specific JSON-RPC
objects. Adapters translate their client experience into these operations:

- `session_overview`: recent accessible sessions, running work, pending prompts,
  recent actions, and unread-event cursor.
- `read_session`: explicit session, chronological typed items, historical page
  or incremental cursor, and delivery visibility.
- `send_message`: explicit session, exact message, immediate or deliberately
  queued delivery, and an authoritative receipt.
- `start_session`: instruction plus server-resolved account host/workspace and
  an optional allowed agent/title.
- `rename_session` and `archive_session`: separate lifecycle operations so a
  model cannot confuse a label change with a destructive action.
- `resolve_prompt`: exact session and prompt identifiers plus a typed action and
  form values.
- `get_updates`: immediate replay after an event cursor.
- `wait_for_updates`: bounded long-poll of the same stream while an active client
  turn deliberately waits.

The voice adapter can continue exposing `focus_session`, compact tool schemas,
and deterministic target routing for a small fast model. Remote Claude tools use
explicit session targets because one OAuth connection may participate in more
than one chat and transport-level focus is not a safe authority boundary.

Every result uses a common envelope containing the acting account, resolved
target, action receipt, pending prompts visible to the caller, event cursor, and
new authorized updates. Typed failures identify whether nothing happened,
something was accepted asynchronously, or one step of a compound request failed.

## Event delivery and graceful degradation

The durable per-account event log is the source of truth. Events are filtered by
ACL before publication and checked again on retrieval.

- Voice subscribes internally and can wake Celeris immediately without spending
  model calls on empty polls.
- Portable MCP exposes `get_updates`, bounded `wait_for_updates`, and an update
  resource. Resource-change notifications tell supporting clients to refetch but
  do not assume that the host starts a model turn.
- A local Claude Code Channels bridge may translate an authorized event into the
  client-specific proactive notification contract.
- Clients with neither facility retain full correctness through explicit opaque
  cursors, idempotent replay, bounded retention, and documented cursor expiry.

Notifications contain only a resource hint and cursor. Session content remains
behind an authenticated fetch so transport metadata cannot leak another user's
work.

## Delivery phases

1. Build the dedicated gateway, delegated-account OAuth flow, token lifecycle,
   encrypted grant store, and adversarial identity/token tests.
2. Deploy a disabled-by-default ingress plus read-only `whoami` and
   `list_sessions`; verify discovery, OAuth, revocation, and account filtering
   from Claude web and mobile.
3. Freeze the broader typed coordinator contract using what the real connector
   reveals, then move the existing voice adapter onto that shared core.
4. Add chronological reads and cursor-backed updates with multi-account
   isolation tests.
5. Enable execution scopes only after cross-account, workspace, prompt approval,
   audit, rate-limit, replay, and revocation gates pass.
6. Add optional advisory resource notifications and the separate Claude Code
   Channels adapter without changing the cursor-backed contract.

Rollback disables the gateway Ingress and scales its Deployment to zero;
ordinary Omnigent routes, sessions, browser access, and the internal voice
adapter remain available.
