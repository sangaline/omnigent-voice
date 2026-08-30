import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "./log.js";
import type { PersonaMemoryRuntime } from "./persona-memory.js";
import {
  PersonaConversation,
  currentCorrectionAnchor,
  defaultPersonaSystemPrompt,
  invalidPersonaResponse,
  personaTurnGroundingInvariant,
} from "./persona.js";

const response = (message: object): Response =>
  new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const streamingResponse = (...payloads: Array<object | "[DONE]">): Response =>
  new Response(
    payloads
      .map((payload) =>
        `data: ${payload === "[DONE]" ? payload : JSON.stringify(payload)}\n\n`
      )
      .join(""),
    {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  );

const conversation = (overrides: Partial<ConstructorParameters<typeof PersonaConversation>[0]> = {}) =>
  new PersonaConversation({
    apiKey: "test-key",
    baseUrl: "https://celeris.invalid/v1",
    model: "test-model",
    logger: new Logger("error"),
    ...overrides,
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("persona conversation", () => {
  it("rejects leaked model control markers", () => {
    expect(invalidPersonaResponse("< channel thought")).toBe(true);
    expect(invalidPersonaResponse("<|channel|>analysis")).toBe(true);
    expect(invalidPersonaResponse("That is a thoughtful answer.")).toBe(false);
  });

  it("extracts an explicit present-tense correction anchor", () => {
    expect(currentCorrectionAnchor(
      "I've actually gotten really into espresso lately so the old coffee thing is out of date",
    )).toBe("espresso");
    expect(currentCorrectionAnchor("I like espresso")).toBeUndefined();
  });

  it("streams natural speech through a tool-free static prompt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      streamingResponse(
        { choices: [{ delta: { content: "Honestly, that sounds like a good excuse to make tea. " } }] },
        { choices: [{ delta: { content: "What happened?" }, finish_reason: "stop" }] },
        { usage: { prompt_tokens: 90, completion_tokens: 17 } },
        "[DONE]",
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const segments: string[] = [];

    await expect(
      conversation({ systemPrompt: "You are candid and warm." }).respond(
        "today has been weird",
        (segment) => segments.push(segment),
      ),
    ).resolves.toBe(
      "Honestly, that sounds like a good excuse to make tea. What happened?",
    );
    expect(segments).toEqual([
      "Honestly, that sounds like a good excuse to make tea.",
      "What happened?",
    ]);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages?: Array<{ role?: string; content?: string }>;
      tools?: unknown;
      tool_choice?: unknown;
      stream?: boolean;
    };
    expect(body.messages?.[0]).toEqual({
      role: "system",
      content: "You are candid and warm.",
    });
    expect(body.messages?.at(-1)).toEqual({
      role: "user",
      content: "today has been weird",
    });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.stream).toBe(true);
  });

  it("can acknowledge and deliberately escalate a difficult turn", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      response({
        content: "Ooh, give me a second to make this one good. ",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "ask_adviser",
              arguments: JSON.stringify({ request: "Tell a clever pottery joke." }),
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const persistentMemory = {
      prepare: vi.fn(),
      contextFor: vi.fn(() => undefined),
      preparedDraftFor: vi.fn(() => undefined),
      hasPreparedResponseIdea: vi.fn(() => false),
      runtimeContext: vi.fn(() => JSON.stringify({ durable_memory_enabled: true })),
      speechReferenceHint: vi.fn(() => undefined),
      rememberTurn: vi.fn(),
      askAdviser: vi.fn(async (
        _request: string,
        _history: unknown,
        onPartial?: (fragment: string) => void,
      ) => {
        onPartial?.("I tried pottery, but I could not handle the pressure.");
        return "I tried pottery, but I could not handle the pressure.";
      }),
    } as unknown as PersonaMemoryRuntime;
    const segments: string[] = [];

    await expect(
      conversation({ persistentMemory }).respond(
        "tell me a good pottery joke",
        (segment) => segments.push(segment),
      ),
    ).resolves.toBe(
      "Ooh, give me a second to make this one good. I tried pottery, but I could not handle the pressure.",
    );
    expect(segments).toEqual([
      "Ooh, give me a second to make this one good.",
      "I tried pottery, but I could not handle the pressure.",
    ]);
    expect(persistentMemory.askAdviser).toHaveBeenCalledWith(
      "tell me a good pottery joke",
      expect.arrayContaining([
        { role: "user", content: "tell me a good pottery joke" },
      ]),
      undefined,
      expect.any(Object),
    );
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      tools?: Array<{ function?: { name?: string } }>;
      tool_choice?: unknown;
      stream?: boolean;
    };
    expect(firstBody.tools?.[0]?.function?.name).toBe("ask_adviser");
    expect(firstBody.tool_choice).toEqual({
      type: "function",
      function: { name: "ask_adviser" },
    });
    expect(firstBody.stream).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("answers the verified DeepSeek speech alias without a lossy model rewrite", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const persistentMemory = {
      prepare: vi.fn(),
      contextFor: vi.fn(() => undefined),
      preparedDraftFor: vi.fn(() => undefined),
      hasPreparedResponseIdea: vi.fn(() => false),
      runtimeContext: vi.fn(() => "{}"),
      speechReferenceHint: vi.fn(() => "The phrase refers to DeepSeek Flash."),
      rememberTurn: vi.fn(),
      askAdviser: vi.fn(),
    } as unknown as PersonaMemoryRuntime;

    await expect(conversation({ persistentMemory }).respond(
      "what is that deep sea flash thing doing in the background",
    )).resolves.toContain("DeepSeek Flash");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers direct provenance questions without another adviser round", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      streamingResponse(
        {
          choices: [
            {
              delta: { content: "Yes, background context can help me answer." },
              finish_reason: "stop",
            },
          ],
        },
        "[DONE]",
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const persistentMemory = {
      prepare: vi.fn(),
      contextFor: vi.fn(() => undefined),
      preparedDraftFor: vi.fn(() => undefined),
      hasPreparedResponseIdea: vi.fn(() => false),
      runtimeContext: vi.fn(() => JSON.stringify({
        background_context_planning_enabled: true,
      })),
      speechReferenceHint: vi.fn(() => undefined),
      rememberTurn: vi.fn(),
      askAdviser: vi.fn(),
    } as unknown as PersonaMemoryRuntime;

    await expect(conversation({ persistentMemory }).respond(
      "did something in the background suggest that answer",
      () => undefined,
    )).resolves.toContain("background context");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      tools?: unknown;
    };
    expect(body.tools).toBeUndefined();
    expect(persistentMemory.askAdviser).not.toHaveBeenCalled();
  });

  it("uses a safe completed background draft without another model round", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const persistentMemory = {
      prepare: vi.fn(),
      contextFor: vi.fn(() => JSON.stringify({ background_turn_brief: {} })),
      preparedDraftFor: vi.fn(() => "Your presentation is today; let the nerves make you sharp."),
      hasPreparedResponseIdea: vi.fn(() => true),
      runtimeContext: vi.fn(() => "{}"),
      speechReferenceHint: vi.fn(() => undefined),
      rememberTurn: vi.fn(),
      askAdviser: vi.fn(),
    } as unknown as PersonaMemoryRuntime;
    const segments: string[] = [];
    const subject = conversation({ persistentMemory });

    await expect(subject.respond(
      "well today's the day and my stomach is doing backflips",
      (segment) => segments.push(segment),
    )).resolves.toBe(
      "Your presentation is today; let the nerves make you sharp.",
    );
    expect(segments).toEqual([
      "Your presentation is today; let the nerves make you sharp.",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistentMemory.rememberTurn).toHaveBeenCalledOnce();

    await expect(subject.respond(
      "did something in the background suggest that answer",
    )).resolves.toContain("DeepSeek Flash prepared that reply");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains conversational history without coordinator state or tools", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ content: "Rainy mornings are underrated." }))
      .mockResolvedValueOnce(response({ content: "You said rainy mornings." }));
    vi.stubGlobal("fetch", fetchMock);
    const subject = conversation();

    await subject.respond("I really like rainy mornings.");
    await subject.respond("What kind of morning did I say I like?");

    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      messages?: Array<{ role?: string; content?: string }>;
      tools?: unknown;
    };
    expect(body.messages).toEqual([
      { role: "system", content: defaultPersonaSystemPrompt },
      { role: "user", content: "I really like rainy mornings." },
      { role: "assistant", content: "Rainy mornings are underrated." },
      { role: "system", content: personaTurnGroundingInvariant },
      { role: "user", content: "What kind of morning did I say I like?" },
    ]);
    expect(JSON.stringify(body)).not.toContain("Current coordinator state");
    expect(body.tools).toBeUndefined();
  });

  it("retries one empty model turn and keeps the successful answer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ content: null }))
      .mockResolvedValueOnce(response({ content: "I am here." }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(conversation().respond("hello?" )).resolves.toBe("I am here.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("survives two invalid model turns before using a valid reply", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ content: null }))
      .mockResolvedValueOnce(response({ content: "< channel thought" }))
      .mockResolvedValueOnce(response({ content: "I am still here." }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(conversation().respond("hello?" )).resolves.toBe("I am still here.");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("buffers and retries a reply that drops an explicit correction anchor", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ content: "Well, that is quite a turnaround." }))
      .mockResolvedValueOnce(response({ content: "Espresso finally won you over." }));
    vi.stubGlobal("fetch", fetchMock);
    const segments: string[] = [];

    await expect(conversation().respond(
      "I've actually gotten really into espresso lately so that old coffee thing is out of date",
      (segment) => segments.push(segment),
    )).resolves.toBe("Espresso finally won you over.");
    expect(segments).toEqual(["Espresso finally won you over."]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    expect(retryBody.messages).toContainEqual({
      role: "system",
      content: expect.stringContaining("omitted the required continuity anchor"),
    });
  });

  it("retries a leaked control marker without sending it to speech", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        streamingResponse(
          { choices: [{ delta: { content: "< channel thought" }, finish_reason: "stop" }] },
          "[DONE]",
        ),
      )
      .mockResolvedValueOnce(
        streamingResponse(
          { choices: [{ delta: { content: "You like the quiet rhythm of the rain." }, finish_reason: "stop" }] },
          "[DONE]",
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const segments: string[] = [];

    await expect(
      conversation().respond("what did I say I liked", (segment) => segments.push(segment)),
    ).resolves.toBe("You like the quiet rhythm of the rain.");
    expect(segments).toEqual(["You like the quiet rhythm of the rain."]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      messages?: Array<{ role?: string; content?: string }>;
      tools?: unknown;
    };
    expect(retryBody.messages).toContainEqual({
      role: "system",
      content: expect.stringContaining("previous model completion was empty"),
    });
    expect(retryBody.tools).toBeUndefined();
  });

  it("bounds spoken replies and uses a local conversational failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(response({ content: "word ".repeat(200) })),
    );
    const bounded = await conversation({ maxResponseCharacters: 100 }).respond("go on");
    expect(bounded.length).toBeLessThanOrEqual(100);

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("offline")));
    await expect(conversation().respond("hello")).resolves.toBe(
      "Sorry, I lost my train of thought for a moment.",
    );
  });

  it("aborts a superseded response and records that it was not heard", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError"));
          }, { once: true });
        }),
      )
      .mockResolvedValueOnce(response({ content: "You were talking about the long week." }));
    vi.stubGlobal("fetch", fetchMock);
    const subject = conversation();
    const controller = new AbortController();
    const interrupted = subject.respond(
      "this week has been kind of exhausting",
      undefined,
      controller.signal,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(interrupted).rejects.toThrow();

    await subject.respond("what was I just talking about");
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    expect(body.messages).toContainEqual({
      role: "user",
      content: "this week has been kind of exhausting",
    });
    expect(body.messages).toContainEqual({
      role: "system",
      content: expect.stringContaining("interrupted before it was completed"),
    });
  });

  it("compacts older persona dialogue while preserving a verbatim recent tail", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ content: "First answer." }))
      .mockResolvedValueOnce(response({ content: "Second answer." }))
      .mockResolvedValueOnce(response({ content: "Third answer." }))
      .mockResolvedValueOnce(
        response({ content: "The human likes rain and has an unresolved weekend plan." }),
      )
      .mockResolvedValueOnce(response({ content: "Fourth answer." }));
    vi.stubGlobal("fetch", fetchMock);
    const subject = conversation({
      memoryPolicy: {
        compactAfterMessages: 4,
        compactAfterCharacters: 10_000,
        keepRecentMessages: 2,
        compactionIdleMs: 1,
      },
    });

    await subject.respond("First question.");
    await subject.respond("Second question.");
    await subject.respond("Third question.");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await subject.respond("Fourth question.");

    const body = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body)) as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    expect(body.messages?.[1]).toEqual({
      role: "system",
      content: expect.stringContaining("The human likes rain"),
    });
    expect(body.messages).toContainEqual({ role: "user", content: "Third question." });
    expect(body.messages).toContainEqual({ role: "assistant", content: "Third answer." });
    expect(body.messages).not.toContainEqual({ role: "user", content: "First question." });
  });
});
