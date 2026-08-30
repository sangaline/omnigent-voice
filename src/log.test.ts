import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "./log.js";

describe("Logger", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("appends the same structured event to stdout and the persistent log", () => {
    const directory = mkdtempSync(join(tmpdir(), "omnigent-voice-log-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "nested", "events.jsonl");
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = new Logger("info", filePath);

    logger.info("conversation.user.recognized", {
      text: "Show me the latest session.",
      audioMs: 1_250,
    });

    const line = readFileSync(filePath, "utf8").trim();
    expect(stdout).toHaveBeenCalledWith(line);
    expect(JSON.parse(line)).toMatchObject({
      level: "info",
      event: "conversation.user.recognized",
      text: "Show me the latest session.",
      audioMs: 1_250,
    });
  });
});
