import { createServer } from "node:http";
import { createRemoteMcpApplication } from "./remote-app.js";
import { loadRemoteMcpConfig } from "./remote-config.js";

process.umask(0o077);
const config = loadRemoteMcpConfig();
const application = createRemoteMcpApplication(config);
const server = createServer(application.app);

server.listen(config.port, "0.0.0.0", () => {
  process.stdout.write(`${JSON.stringify({
    time: new Date().toISOString(),
    event: "remote_mcp.ready",
    port: config.port,
    read_only: true,
  })}\n`);
});

const shutdown = (): void => {
  server.close(() => {
    application.store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
