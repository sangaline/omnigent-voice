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

  it("exposes the focused coordinator tools over an in-memory MCP transport", async () => {
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
      listItems: vi.fn().mockResolvedValue({ data: [], hasMore: false }),
      sendMessage: vi.fn(),
      resolveElicitation: vi.fn(),
      createSession: vi.fn(),
      archiveSession: vi.fn(),
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
        "poll_output",
        "send_message",
        "archive_session",
        "answer_prompt",
        "start_session",
        "check_updates",
      ]);
      await expect(
        client.callTool("list_sessions", { status: "waiting_for_input" }),
      ).resolves.toMatchObject({
        sessions: [
          { id: "session-1", name: "Voice MVP", pending_prompts: 1, focused: true },
        ],
        focused_session: { id: "session-1", name: "Voice MVP" },
        updates: [],
      });
    } finally {
      coordinator.stop();
      await client.close();
    }
  });

  it("snapshots new stable output and keeps immediate delivery distinct from queuing", async () => {
    const now = new Date().toISOString();
    const session = {
      id: "session-1",
      title: "Voice MVP",
      status: "running",
      updated_at: now,
    };
    const listItems = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: "old", type: "message", role: "assistant", content: "Old" }],
        hasMore: false,
      })
      .mockResolvedValue({
        data: [
          {
            id: "new",
            type: "message",
            role: "assistant",
            content: "The deployment is ready.",
          },
          { id: "old", type: "message", role: "assistant", content: "Old" },
        ],
        hasMore: false,
      });
    const sendMessage = vi.fn().mockResolvedValue({ queued: true });
    const omnigent = {
      listSessions: vi.fn().mockResolvedValue([session]),
      getSession: vi.fn().mockResolvedValue(session),
      listItems,
      sendMessage,
      resolveElicitation: vi.fn(),
      createSession: vi.fn(),
      archiveSession: vi.fn(),
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
      await expect(client.callTool("check_updates", {})).resolves.toMatchObject({
        focused_session: { id: "session-1", name: "Voice MVP" },
        output_delta: { changed: true, output: "assistant: The deployment is ready." },
      });
      const firstPoll = await client.callTool("poll_output", {});
      expect(firstPoll).toMatchObject({
        changed: true,
        output: "assistant: The deployment is ready.",
        cursor: "new",
        cursor_expired: false,
      });
      await expect(
        client.callTool("poll_output", { cursor: firstPoll.cursor }),
      ).resolves.toMatchObject({
        changed: false,
        output: "",
        cursor: "new",
        cursor_expired: false,
      });
      const immediate = await client.callTool("send_message", { message: "Continue." });
      expect(immediate).toMatchObject({
        accepted: true,
        delivery: "immediate",
        target_session: { id: "session-1", name: "Voice MVP" },
        backend_async_accepted: true,
        recent_actions: [
          {
            action_id: 1,
            type: "message_sent",
            name: "Voice MVP",
            delivery: "immediate",
            message: "Continue.",
          },
        ],
      });
      expect(immediate).not.toHaveProperty("queued");
      await expect(
        client.callTool("send_message", { message: "Do this later.", delivery: "queued" }),
      ).resolves.toMatchObject({
        accepted: true,
        delivery: "queued",
        target_session: { id: "session-1", name: "Voice MVP" },
        queued_messages: 1,
      });
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      coordinator.stop();
      await client.close();
    }
  });

  it("restores the previous focus after archiving a temporary session", async () => {
    const now = new Date().toISOString();
    const primary = {
      id: "session-primary",
      title: "Primary work",
      status: "idle",
      updated_at: now,
    };
    const temporary = {
      id: "session-temporary",
      title: "Temporary side task",
      status: "idle",
      updated_at: now,
    };
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce([primary, temporary])
      .mockResolvedValue([primary]);
    const archiveSession = vi.fn().mockResolvedValue({ archived: true });
    const omnigent = {
      listSessions,
      getSession: vi.fn().mockImplementation((id: string) =>
        Promise.resolve(id === temporary.id ? temporary : primary),
      ),
      listItems: vi.fn().mockResolvedValue({ data: [], hasMore: false }),
      sendMessage: vi.fn(),
      resolveElicitation: vi.fn(),
      createSession: vi.fn(),
      archiveSession,
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
      await client.callTool("focus_session", { session_id: temporary.id });
      await expect(client.callTool("archive_session", {})).resolves.toMatchObject({
        archived: true,
        archived_session: { id: temporary.id, name: "Temporary side task" },
        focus_reason: "previous_focus",
        focused_session: { id: primary.id, name: "Primary work" },
        recent_actions: [
          { type: "focus_changed", name: "Temporary side task" },
          {
            type: "session_archived",
            name: "Temporary side task",
            next_focus: { id: primary.id, name: "Primary work" },
          },
        ],
      });
      expect(archiveSession).toHaveBeenCalledWith(temporary.id);
    } finally {
      coordinator.stop();
      await client.close();
    }
  });

  it("supports replayable event cursors without globally draining updates", async () => {
    const now = new Date().toISOString();
    const running = {
      id: "session-1",
      title: "Voice MVP",
      status: "running",
      updated_at: now,
    };
    const idle = { ...running, status: "idle" };
    const omnigent = {
      listSessions: vi
        .fn()
        .mockResolvedValueOnce([running])
        .mockResolvedValue([idle]),
      getSession: vi.fn().mockResolvedValue(idle),
      listItems: vi.fn().mockResolvedValue({ data: [], hasMore: false }),
      sendMessage: vi.fn(),
      resolveElicitation: vi.fn(),
      createSession: vi.fn(),
      archiveSession: vi.fn(),
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
      const first = await client.callTool("check_updates", { after_event_id: 0 });
      expect(first).toMatchObject({
        update_cursor: 1,
        update_cursor_expired: false,
        updates: [{ event_id: 1, type: "session_completed", session_id: "session-1" }],
      });
      await expect(client.callTool("list_sessions", {})).resolves.toMatchObject({
        update_cursor: 1,
        updates: [],
      });
      await expect(
        client.callTool("check_updates", { after_event_id: 0 }),
      ).resolves.toMatchObject({
        update_cursor: 1,
        updates: [{ event_id: 1, type: "session_completed" }],
      });
      await expect(
        client.callTool("check_updates", { after_event_id: 1 }),
      ).resolves.toMatchObject({ update_cursor: 1, updates: [] });
    } finally {
      coordinator.stop();
      await client.close();
    }
  });
});
