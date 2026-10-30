import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OmnigentCoordinator } from "./coordinator.js";
import { Logger } from "./log.js";
import { createCoordinatorMcpServer } from "./mcp.js";
import { OmnigentClient } from "./omnigent.js";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const logger = new Logger("error");
const omnigent = new OmnigentClient({
  baseUrl: required("OMNIGENT_BASE_URL").replace(/\/$/, ""),
  refreshToken: required("OMNIGENT_REFRESH_TOKEN"),
  agentName: process.env.OMNIGENT_AGENT_NAME?.trim() || "codex-native-ui",
  hostId: process.env.OMNIGENT_HOST_ID?.trim(),
  workspace: required("OMNIGENT_WORKSPACE"),
  logger,
});
const coordinator = new OmnigentCoordinator({ omnigent, logger });
await coordinator.start();
const server = createCoordinatorMcpServer(coordinator);
await server.connect(new StdioServerTransport());

const shutdown = (): void => {
  coordinator.stop();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
