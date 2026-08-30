import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "./log.js";
import {
  OpenAiPersonaAdviser,
  PersonaAdviser,
  PersonaEmbedder,
  PersonaMemoryRuntime,
  PersonaMemorySelection,
  PersonaMemoryStore,
  PersonaTurnAnalysis,
  groundedMemoryCandidate,
  selfContainedPersonaRequest,
  unsafeCreativeDraft,
  usefulPersonaThought,
} from "./persona-memory.js";

class FakeStore implements PersonaMemoryStore {
  public initialized = false;
  public closed = false;
  public turns: Array<{ owner: string; user: string; assistant: string }> = [];
  public saved: PersonaTurnAnalysis[] = [];
  public consumed: string[] = [];
  public selection: PersonaMemorySelection = { memories: [] };

  public async initialize(): Promise<void> {
    this.initialized = true;
  }

  public async recentDialogue(): Promise<
    Array<{ role: "user" | "assistant"; content: string }>
  > {
    return [
      { role: "user", content: "I like rainy mornings." },
      { role: "assistant", content: "They make the day feel unhurried." },
    ];
  }

  public async recordTurn(owner: string, user: string, assistant: string): Promise<string> {
    this.turns.push({ owner, user, assistant });
    return String(this.turns.length);
  }

  public async retrieve(): Promise<PersonaMemorySelection> {
    return this.selection;
  }

  public async saveAnalysis(
    _owner: string,
    _turnId: string,
    analysis: PersonaTurnAnalysis,
  ): Promise<void> {
    this.saved.push(analysis);
  }

  public async consumeThought(_owner: string, thoughtId: string): Promise<void> {
    this.consumed.push(thoughtId);
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}

const fakeEmbedder = (): PersonaEmbedder => ({
  embed: vi.fn(async (texts: readonly string[]) =>
    texts.map(() => [1, 0, 0])),
});

const fakeAdviser = (analysis: PersonaTurnAnalysis = { memories: [] }): PersonaAdviser => ({
  analyzeTurn: vi.fn(async () => analysis),
  planTurn: vi.fn(async () => ({
    draftReply: "Ask about pottery naturally.",
    memoryAnchor: "",
    memoryAnchorDecided: true,
    interpretation: "The user is asking about pottery.",
    relevantFacts: [],
    responseStrategy: "Answer naturally.",
    responseIdeas: [],
    needsAdviser: false,
    shouldClarify: false,
  })),
  advise: vi.fn(async () => "Try the pottery joke with a drier punchline."),
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("persona memory runtime", () => {
  it("restores recent dialogue and injects only already-prefetched memory", async () => {
    const store = new FakeStore();
    store.selection = {
      memories: [
        {
          id: "12",
          kind: "preference",
          canonicalKey: "user.preference.rainy-mornings",
          text: "The user likes rainy mornings.",
          source: "user",
          evidenceQuote: "I like rainy mornings",
          confidence: 0.98,
          importance: 0.7,
          createdAt: "2026-08-30T00:00:00.000Z",
        },
      ],
      thought: {
        id: "4",
        text: "Rain might be a playful callback.",
        topic: "rainy mornings",
        confidence: 0.8,
      },
    };
    const runtime = new PersonaMemoryRuntime({
      ownerKey: "test-owner",
      store,
      embedder: fakeEmbedder(),
      adviser: fakeAdviser(),
      logger: new Logger("error"),
      backgroundModel: "deepseek/deepseek-v4-flash",
      usePreparedDrafts: true,
    });

    await expect(runtime.initialize()).resolves.toHaveLength(2);
    expect(store.initialized).toBe(true);
    runtime.prepare("What kind of mornings do I like?");
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtime.contextFor("What kind of mornings do I like?"))
      .toContain("The user likes rainy mornings");
    await vi.waitFor(() => expect(store.consumed).toContain("4"));
    await runtime.close();
  });

  it("performs one bounded cold lookup for an explicit recall question", async () => {
    const store = new FakeStore();
    store.selection = {
      memories: [
        {
          id: "13",
          kind: "user_fact",
          canonicalKey: "user.name",
          text: "The user's name is Morgan.",
          source: "user",
          evidenceQuote: "call me Morgan",
          confidence: 1,
          importance: 0.9,
          relevance: 0.92,
          createdAt: "2026-08-30T00:00:00.000Z",
        },
      ],
    };
    const runtime = new PersonaMemoryRuntime({
      ownerKey: "test-owner",
      store,
      embedder: fakeEmbedder(),
      adviser: fakeAdviser(),
      logger: new Logger("error"),
    });
    await runtime.initialize();

    await expect(runtime.contextForRecall("Do you know my name?", 250))
      .resolves.toContain("The user's name is Morgan");
    await runtime.close();
  });

  it("records and analyzes a completed turn outside the caller's hot path", async () => {
    let releaseAnalysis: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      releaseAnalysis = resolve;
    });
    const store = new FakeStore();
    const adviser: PersonaAdviser = {
      analyzeTurn: vi.fn(async (): Promise<PersonaTurnAnalysis> => {
        await wait;
        return {
          memories: [
            {
              kind: "episode",
              canonicalKey: "shared.episode.pottery-start",
              text: "The user started pottery last month.",
              source: "user",
              evidenceQuote: "I started pottery last month",
              confidence: 1,
              importance: 0.6,
            },
          ],
        };
      }),
      planTurn: vi.fn(async () => ({
        draftReply: "Pottery sounds like a good kind of mess.",
        memoryAnchor: "pottery",
        memoryAnchorDecided: true,
        interpretation: "The user is talking about pottery.",
        relevantFacts: [],
        responseStrategy: "Respond warmly.",
        responseIdeas: [],
        needsAdviser: false,
        shouldClarify: false,
      })),
      advise: vi.fn(async () => "A better idea."),
    };
    const runtime = new PersonaMemoryRuntime({
      ownerKey: "test-owner",
      store,
      embedder: fakeEmbedder(),
      adviser,
      logger: new Logger("error"),
      backgroundModel: "deepseek/deepseek-v4-flash",
      usePreparedDrafts: true,
    });
    await runtime.initialize();

    runtime.rememberTurn("I started pottery last month.", "That sounds fun.");
    expect(store.saved).toEqual([]);
    releaseAnalysis?.();
    await runtime.close();

    expect(store.turns).toEqual([
      {
        owner: "test-owner",
        user: "I started pottery last month.",
        assistant: "That sounds fun.",
      },
    ]);
    expect(store.saved[0]?.memories[0]?.text).toBe(
      "The user started pottery last month.",
    );
    expect(store.closed).toBe(true);
  });

  it("precomputes a response brief from partial speech without blocking the turn", async () => {
    const store = new FakeStore();
    const adviser: PersonaAdviser = {
      analyzeTurn: vi.fn(async () => ({ memories: [] })),
      planTurn: vi.fn(async () => ({
        draftReply: "DeepSeek Flash prepares context while you speak.",
        memoryAnchor: "",
        memoryAnchorDecided: true,
        interpretation: "The user means the DeepSeek Flash background model.",
        relevantFacts: ["Background planning can contribute private context."],
        responseStrategy: "Answer the architecture question directly.",
        responseIdeas: ["Yes, DeepSeek can prepare context while you speak."],
        needsAdviser: false,
        shouldClarify: false,
      })),
      advise: vi.fn(async () => "A better idea."),
    };
    const runtime = new PersonaMemoryRuntime({
      ownerKey: "test-owner",
      store,
      embedder: fakeEmbedder(),
      adviser,
      logger: new Logger("error"),
      backgroundModel: "deepseek/deepseek-v4-flash",
      usePreparedDrafts: true,
    });
    await runtime.initialize();

    runtime.prepare("what is that deep sea flash stuff", [
      { role: "assistant", content: "A background model can prepare response ideas." },
    ]);
    await vi.waitFor(() => expect(runtime.hasPreparedResponseIdea(
      "what is that deep sea flash stuff in background",
    )).toBe(true));
    expect(runtime.preparedDraftFor("what is that deep sea flash stuff in background"))
      .toBe("DeepSeek Flash prepares context while you speak.");
    expect(runtime.contextFor("what is that deep sea flash stuff in background"))
      .toContain("DeepSeek Flash");
    expect(runtime.speechReferenceHint("what is the deep sea flash thing"))
      .toContain("DeepSeek Flash");
    await runtime.close();
  });
});

describe("OpenAI-compatible persona adviser", () => {
  it("recognizes requests that need a self-contained contribution", () => {
    expect(selfContainedPersonaRequest(
      "give me one tiny reset that doesn't feel like homework",
    )).toBe(true);
    expect(selfContainedPersonaRequest("tell me what you really think")).toBe(true);
    expect(selfContainedPersonaRequest("did you like it")).toBe(false);
  });

  it("rejects stock or purportedly factual joke drafts", () => {
    expect(unsafeCreativeDraft(
      "tell me a weird joke",
      "Why did the scarecrow win? He was outstanding in his field.",
    )).toBe(true);
    expect(unsafeCreativeDraft(
      "tell me a weird joke",
      "Okay, weird fact: octopuses have three hearts.",
    )).toBe(true);
    expect(unsafeCreativeDraft(
      "tell me a weird joke",
      "A sock developed existential dread because its twin kept finishing its sentences.",
    )).toBe(true);
    expect(unsafeCreativeDraft(
      "tell me a weird joke",
      "Imagine a sock developing existential dread because its twin keeps finishing its sentences.",
    )).toBe(false);
    expect(unsafeCreativeDraft(
      "tell me something ordinary",
      "Did you know crows remember faces?",
    )).toBe(false);
    expect(unsafeCreativeDraft(
      "tell me a weird joke",
      "Imagine a snail buying a fast car so everyone says, look at that snail go!",
    )).toBe(true);
  });

  it("does not speak creative planner drafts directly", async () => {
    const store = new FakeStore();
    const adviser = fakeAdviser();
    const runtime = new PersonaMemoryRuntime({
      ownerKey: "test",
      store,
      embedder: fakeEmbedder(),
      adviser,
      logger: new Logger("error"),
      usePreparedDrafts: true,
    });
    await runtime.initialize();
    runtime.prepare("tell me a genuinely weird little joke", []);
    await vi.waitFor(() => {
      expect(adviser.planTurn).toHaveBeenCalled();
    });
    expect(runtime.preparedDraftFor("tell me a genuinely weird little joke"))
      .toBeUndefined();
    await runtime.close();
  });

  it("rejects a user fact inferred only from Audrey's own words", () => {
    expect(groundedMemoryCandidate(
      {
        kind: "user_fact",
        canonical_key: "user.name",
        text: "The user's name is Casey.",
        source: "assistant",
        evidence_quote: "Your name is Casey",
        confidence: 0.9,
        importance: 0.9,
      },
      "Are you remembering?",
      "Yes. Your name is Casey.",
    )).toBeUndefined();

    expect(groundedMemoryCandidate(
      {
        kind: "user_fact",
        canonical_key: "user.name",
        text: "The user's name is Casey.",
        source: "user",
        evidence_quote: "I'm Casey",
        confidence: 1,
        importance: 0.9,
      },
      "I'm Casey.",
      "Nice to meet you, Casey.",
    )).toMatchObject({ canonicalKey: "user.name", source: "user" });
  });

  it("rejects ambiguous, transient, and fictional durable memories", () => {
    expect(groundedMemoryCandidate(
      {
        kind: "user_fact",
        canonical_key: "user.memory.quality",
        text: "The user describes their memory as decent.",
        source: "user",
        evidence_quote: "A decent memory",
        confidence: 0.8,
        importance: 0.5,
      },
      "A decent memory",
      "I'm doing my best to keep up.",
    )).toBeUndefined();

    expect(groundedMemoryCandidate(
      {
        kind: "episode",
        canonical_key: "shared.episode.cloud-joke",
        text: "Audrey told a fictional joke about a cloud.",
        source: "assistant",
        evidence_quote: "Imagine a cloud",
        confidence: 0.9,
        importance: 0.4,
      },
      "Tell me a joke",
      "Imagine a cloud trying to hide.",
    )).toBeUndefined();

    expect(groundedMemoryCandidate(
      {
        kind: "user_fact",
        canonical_key: "user.observation.latency",
        text: "The user says response latency feels higher.",
        source: "user",
        evidence_quote: "I meant the latency feels higher",
        confidence: 0.9,
        importance: 0.5,
      },
      "I meant the latency feels higher",
      "That kills the flow.",
    )).toBeUndefined();
  });

  it("requires name evidence to contain the claimed name", () => {
    expect(groundedMemoryCandidate(
      {
        kind: "user_fact",
        canonical_key: "user.name",
        text: "The user's name is Casey.",
        source: "user",
        evidence_quote: "Remember my name",
        confidence: 1,
        importance: 0.9,
      },
      "Remember my name",
      "I've got it, Casey.",
    )).toBeUndefined();
  });

  it("keeps substantive private thoughts and rejects interview prompts", () => {
    expect(usefulPersonaThought(
      "Rainy mornings could be a playful callback to the user's preference.",
    )).toBe(true);
    expect(usefulPersonaThought(
      "Ask the user if there is something specific they want remembered.",
    )).toBe(false);
    expect(usefulPersonaThought(
      "Gently steer back to personal conversation or ask if they want another topic.",
    )).toBe(false);
  });

  it("parses bounded structured memories without exposing its key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  memories: [
                    {
                      kind: "user_fact",
                      canonical_key: "user.hobby.pottery",
                      text: "The user started pottery last month.",
                      source: "user",
                      evidence_quote: "I started pottery last month",
                      confidence: 1,
                      importance: 0.6,
                    },
                  ],
                  thought: null,
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adviser = new OpenAiPersonaAdviser({
      baseUrl: "https://adviser.invalid/v1",
      apiKey: "private-test-key",
      model: "test-model",
      timeoutMs: 1_000,
      logger: new Logger("error"),
    });

    await expect(
      adviser.analyzeTurn("I started pottery last month.", "That sounds fun."),
    ).resolves.toEqual({
      memories: [
        {
          kind: "user_fact",
          canonicalKey: "user.hobby.pottery",
          text: "The user started pottery last month.",
          source: "user",
          evidenceQuote: "I started pottery last month",
          confidence: 1,
          importance: 0.6,
        },
      ],
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      response_format?: { type?: string };
    };
    expect(body.response_format?.type).toBe("json_schema");
    expect(JSON.stringify(body)).not.toContain("private-test-key");
  });

  it("selects the first safe candidate from structured creative advice", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  candidates: [
                    "A scarecrow was outstanding in his field.",
                    "Imagine a sock developing existential dread because its twin keeps finishing its sentences.",
                    "Picture this: a moonbeam files a noise complaint against the stars.",
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adviser = new OpenAiPersonaAdviser({
      baseUrl: "https://adviser.invalid/v1",
      apiKey: "private-test-key",
      model: "test-model",
      timeoutMs: 1_000,
      logger: new Logger("error"),
    });
    const fragments: string[] = [];

    await expect(adviser.advise(
      "tell me a weird joke",
      { memories: [], recentDialogue: [] },
      (fragment) => fragments.push(fragment),
    )).resolves.toContain("sock developing existential dread");
    expect(fragments).toEqual([
      "Imagine a sock developing existential dread because its twin keeps finishing its sentences.",
    ]);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      response_format?: { type?: string };
    };
    expect(body.response_format?.type).toBe("json_schema");
  });
});
