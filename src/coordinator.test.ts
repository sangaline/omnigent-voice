import { describe, expect, it, vi } from "vitest";
import { formatConversationItem, OmnigentCoordinator, timeAgo } from "./coordinator.js";
import { Logger } from "./log.js";
import { CoordinatorMcpClient } from "./mcp.js";
import { OmnigentClient } from "./omnigent.js";

describe("Omnigent coordinator", () => {
  it("formats stable voice-facing time and output", () => {
    expect(timeAgo("2026-08-28T12:00:00Z", Date.parse("2026-08-28T12:03:00Z"))).toBe(
      "3 minutes ago",
    );
    expect(
      formatConversationItem({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Deployment is ready." }],
      }),
    ).toBe("assistant: Deployment is ready.");
    expect(
      formatConversationItem({
        type: "terminal_command",
        input: "kubectl get pods",
        stdout: "voice 1/1 Running",
        stderr: "",
      }),
    ).toContain("voice 1/1 Running");
  });

  it("exposes the seven small tools over an in-memory MCP transport", async () => {
    const now = new Date().toISOString();
    const omnigent = {
      listSessions: vi.fn().mockResolvedValue([
        {
          id: "session-1",
          title: "Voice MVP",
          status: "running",
          updated_at: now,
          pending_elicitations_count: 1,
        },
      ]),
      getSession: vi.fn(),
      listItems: vi.fn(),
      sendMessage: vi.fn(),
      resolveElicitation: vi.fn(),
      createSession: vi.fn(),
      interruptSession: vi.fn(),
    } as unknown as OmnigentClient;
    const coordinator = new OmnigentCoordinator({
      omnigent,
      logger: new Logger("error"),
      pollIntervalMs: 60_000,
    });
    await coordinator.start();
    const client = await CoordinatorMcpClient.create(coordinator);
    try {
      const tools = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "list_sessions",
        "focus_session",
        "get_output",
        "send_message",
        "answer_prompt",
        "start_session",
        "check_updates",
      ]);
      await expect(
        client.callTool("list_sessions", { status: "waiting_for_input" }),
      ).resolves.toMatchObject({
        sessions: [{ id: "session-1", name: "Voice MVP", pending_prompts: 1 }],
        updates: [],
      });
    } finally {
      coordinator.stop();
      await client.close();
    }
  });
});
