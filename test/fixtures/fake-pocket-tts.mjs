import { createInterface } from "node:readline";

const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const samples = Buffer.from(new Float32Array([0.25, -0.5]).buffer).toString("base64");
const active = new Map();

emit({ type: "ready", sample_rate: 1_000 });
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "cancel") {
    const timer = active.get(request.id);
    if (timer) {
      clearInterval(timer);
      active.delete(request.id);
      emit({ type: "done", id: request.id, cancelled: true });
    }
    return;
  }
  if (request.text === "fail") {
    emit({ type: "error", id: request.id, error: "SyntheticError" });
    return;
  }
  let chunks = 0;
  const timer = setInterval(() => {
    emit({ type: "chunk", id: request.id, audio: samples });
    chunks += 1;
    if (chunks < (request.text === "long" ? 100 : 2)) return;
    clearInterval(timer);
    active.delete(request.id);
    emit({ type: "done", id: request.id });
  }, 2);
  active.set(request.id, timer);
});
