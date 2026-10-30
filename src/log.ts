import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

type Fields = Record<string, boolean | number | string | null | undefined>;

const priority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class Logger {
  public constructor(
    private readonly minimum: LogLevel,
    private readonly filePath?: string,
  ) {
    if (filePath) {
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, "", { encoding: "utf8" });
    }
  }

  public debug(event: string, fields?: Fields): void {
    this.write("debug", event, fields);
  }

  public info(event: string, fields?: Fields): void {
    this.write("info", event, fields);
  }

  public warn(event: string, fields?: Fields): void {
    this.write("warn", event, fields);
  }

  public error(event: string, error: unknown, fields?: Fields): void {
    this.write("error", event, { ...fields, error: errorMessage(error) });
  }

  private write(level: LogLevel, event: string, fields: Fields = {}): void {
    if (priority[level] < priority[this.minimum]) return;
    const record = {
      time: new Date().toISOString(),
      level,
      event,
      ...fields,
    };
    const line = JSON.stringify(record);
    if (this.filePath) {
      appendFileSync(this.filePath, `${line}\n`, { encoding: "utf8" });
    }
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}
