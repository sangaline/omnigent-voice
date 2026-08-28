import { loadConfig } from "./config.js";

const config = loadConfig(process.env);

console.log(JSON.stringify({
  event: "startup",
  agent: config.omnigentAgentName,
  celerisEnabled: Boolean(config.celerisApiKey),
}));

