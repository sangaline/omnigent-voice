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
          text: "The user likes rainy mornings.",
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
    });

    await expect(runtime.initialize()).resolves.toHaveLength(2);
    expect(store.initialized).toBe(true);
    expect(runtime.contextFor("What kind of mornings do I like?")).toBeUndefined();
    await vi.waitFor(() =>
      expect(runtime.contextFor("What kind of mornings do I like?"))
        .toContain("The user likes rainy mornings"),
    );
    await vi.waitFor(() => expect(store.consumed).toContain("4"));
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
              text: "The user started pottery last month.",
              confidence: 1,
              importance: 0.6,
            },
          ],
        };
      }),
      advise: vi.fn(async () => "A better idea."),
    };
    const runtime = new PersonaMemoryRuntime({
      ownerKey: "test-owner",
      store,
      embedder: fakeEmbedder(),
      adviser,
      logger: new Logger("error"),
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
});

describe("OpenAI-compatible persona adviser", () => {
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
                      text: "The user started pottery last month.",
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
          text: "The user started pottery last month.",
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
});
