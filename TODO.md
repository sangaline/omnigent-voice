# Omnigent Voice TODO

## Authenticated MCP integration

- Keep the in-process voice transport and stdio server as the canonical,
  non-networked coordinator implementation. Design any remote adapter as a thin
  transport layer rather than duplicating tool behavior.
- Map the existing Omnigent GitHub OAuth identity onto narrow coordinator
  authorization. Before exposing a listener, write the threat model for this
  remote-code-execution boundary: private reachability, caller identity,
  per-session authorization, audit attribution, token handling, rate limits,
  and revocation.
- Verify the exact supported authentication and transport flows for Claude Code,
  Claude mobile/web, and Codex against current primary documentation, including
  OAuth discovery, client registration, callbacks, and Streamable HTTP support.
- Preserve cursor-backed `check_updates` and `poll_output` as the interoperable
  correctness path. Treat standard MCP resource/list notifications as advisory;
  evaluate a separate Claude Channels adapter only where a local Claude Code
  process needs true unsolicited wake-ups.
- Specify graceful degradation for clients without push: explicit cursors,
  idempotent replay, bounded event retention, cursor-expiry behavior, and cheap
  client polling.
- Produce an implementation estimate and staged plan before adding any public or
  remotely reachable endpoint.

## Voice follow-ups after the current deployment

- Live-test that a long Celeris answer stops at a complete sentence and that a
  “what trailed off?” follow-up sees exactly the speech Discord played.
- Review the next retained voice sample for missed coordinator updates,
  repetitive explanations, truthfulness, and end-to-end latency; turn any new
  failures into sanitized shared-harness regressions.
- Continue the isolated multi-session autoresearch loop without accessing or
  mutating excluded user sessions.
