# Omnigent Voice TODO

## Persona model A/B candidates

- Once the context and memory harness is stable, run the exact same stateful
  persona scenarios against Cerebras Gemma 4 31B and Celeris. Do not swap the
  live model based on advertised throughput alone. Measure p50/p95 time to first
  content, complete voice-sized turn latency, instruction adherence, ASR repair,
  provenance truthfulness, warmth/humor, repetition, and actual token cost.
- Cerebras currently lists Gemma 4 31B as a medium dedicated-endpoint model and
  positions it for low-latency chat/reasoning, but it is not in the documented
  public shared-endpoint catalog. Confirm account access, exact model ID, price,
  context limit, structured output, tool calling, streaming behavior, and the
  claimed roughly 500 tokens/second before building an adapter.
- Weight first-token latency and quality more heavily than raw decode speed:
  Audrey usually speaks only tens of tokens, so a smarter 31B model can win even
  at roughly twice the cost, but 500 tokens/second by itself saves little if
  queueing or first-token latency dominates.

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
- Live-test the new content-free send-preamble continuation window using a short
  phone pause, then verify the merged correction reaches the intended session
  exactly once and retains its attribution, numbers, and conditions.
- Live-test authenticated Omnigent SSE delivery from the phone: confirm a
  current-session reply is available while the caller is speaking, a finalized
  reply is announced once, and the later stable item or a reconnect snapshot
  does not repeat it. Stable cursor polling remains the fallback; live event
  access stays inside the existing private voice trust boundary.
- The coordinator-oriented multi-session autoresearch loop is paused at the
  human's request; current autonomous iteration is persona-only.
