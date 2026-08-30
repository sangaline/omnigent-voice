import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "./log.js";
import {
  PersonaConversation,
  defaultPersonaSystemPrompt,
  invalidPersonaResponse,
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
