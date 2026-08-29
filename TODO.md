# Omnigent Voice TODO

## Authenticated MCP integration

- Treat `docs/MCP-SECURITY.md` as a release gate. Do not add a remotely
  reachable transport until its identity, authorization, isolation, revocation,
  audit, and abuse tests pass.
- Complete the real Claude web/mobile connector test and revocation exercise for
  the deployed gateway described in `docs/MCP-ARCHITECTURE.md`. It starts with
  read-only `whoami` and `list_sessions`; every upstream request uses the
  caller's encrypted Omnigent grant and ordinary session ACLs.
- Treat the gateway as the future account-scoped semantic boundary. Keep the
  current in-process voice transport intact for the auth milestone, then move it
  onto the proven gateway core instead of maintaining duplicate tool behavior.
- Map the existing Omnigent GitHub/OIDC identity onto narrow coordinator
  authorization through the one-time CLI-ticket proof. Never use a global
  Omnigent credential, a user-identity header, or browser cookies on MCP tool
  routes.
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
- Before adding any write-capable remote tool, repeat discovery, PKCE, consent,
  code replay, refresh rotation/reuse, revocation, cross-account isolation,
  rate limiting, and credential-log tests against the changed surface.
- Add bounded opportunistic cleanup for expired OAuth codes, tokens, and stale
  dynamically registered clients before opening the gateway to wider use.

## Voice follow-ups after the current deployment

- Live-test that a long Celeris answer stops at a complete sentence and that a
  “what trailed off?” follow-up sees exactly the speech Discord played.
- Review the next retained voice sample for missed coordinator updates,
  repetitive explanations, truthfulness, and end-to-end latency; turn any new
  failures into sanitized shared-harness regressions.
- Convert the retained ETA failure into a linked regression suite at several
  cut points: after the outbound question, after unrelated progress, after an
  explicit update check, and after the human correction supplies the missing
  answer. Assert that the harness reads current-session output instead of
  repeating stale waiting state, never denies a fact present in the current
  human turn or authoritative update, and never promises a future report without
  backend evidence.
- Reproduce the overlapping-turn failure from the same trace: a superseded
  partial request must not emit its late completion during the replacement
  utterance, and no later verification question may claim an action occurred
  without a matching action-ledger receipt. Determine separately whether the
  ETA response was absent from Omnigent's stable items or skipped by the
  coordinator cursor before changing the prompt.
- Continue the isolated multi-session autoresearch loop without accessing or
  mutating excluded user sessions.
