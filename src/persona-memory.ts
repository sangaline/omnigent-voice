import pg from "pg";
import type { CelerisHistoryMessage } from "./celeris.js";
import { Logger } from "./log.js";

const { Pool } = pg;

export const personaMemoryKinds = [
  "user_fact",
  "preference",
  "relationship",
  "episode",
  "open_loop",
  "audrey_self",
] as const;

export type PersonaMemoryKind = (typeof personaMemoryKinds)[number];

export interface PersonaMemoryCandidate {
  kind: PersonaMemoryKind;
  text: string;
  confidence: number;
  importance: number;
}

export interface PersonaThoughtCandidate {
  text: string;
  topic: string;
  confidence: number;
}

export interface PersonaTurnAnalysis {
  memories: PersonaMemoryCandidate[];
  thought?: PersonaThoughtCandidate | undefined;
}

export interface PersonaMemoryRecord extends PersonaMemoryCandidate {
  id: string;
  createdAt: string;
}

export interface PersonaThoughtRecord extends PersonaThoughtCandidate {
  id: string;
}

export interface PersonaMemorySelection {
  memories: PersonaMemoryRecord[];
  thought?: PersonaThoughtRecord | undefined;
}

export interface PersonaMemoryStore {
  initialize(): Promise<void>;
  recentDialogue(ownerKey: string, turns: number): Promise<CelerisHistoryMessage[]>;
  recordTurn(ownerKey: string, user: string, assistant: string): Promise<string>;
  retrieve(
    ownerKey: string,
    query: string,
    embedding: readonly number[] | undefined,
    limit: number,
  ): Promise<PersonaMemorySelection>;
  saveAnalysis(
    ownerKey: string,
    turnId: string,
    analysis: PersonaTurnAnalysis,
    memoryEmbeddings: readonly (readonly number[] | undefined)[],
    thoughtEmbedding: readonly number[] | undefined,
  ): Promise<void>;
  consumeThought(ownerKey: string, thoughtId: string): Promise<void>;
  close(): Promise<void>;
}

export interface PersonaEmbedder {
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface PersonaAdviser {
  analyzeTurn(user: string, assistant: string): Promise<PersonaTurnAnalysis>;
  advise(
    request: string,
    context: {
      memories: readonly PersonaMemoryRecord[];
      recentDialogue: readonly CelerisHistoryMessage[];
    },
  ): Promise<string>;
}

export interface PostgresPersonaMemoryStoreOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  embeddingDimensions: number;
  logger: Logger;
}

const vectorLiteral = (embedding: readonly number[] | undefined): string | null => {
  if (!embedding) return null;
  if (embedding.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding contains a non-finite value");
  }
  return `[${embedding.join(",")}]`;
};

const normalizedMemoryText = (text: string): string =>
  text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const boundedScore = (value: number, fallback: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;

export class PostgresPersonaMemoryStore implements PersonaMemoryStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(private readonly options: PostgresPersonaMemoryStoreOptions) {
    if (
      !Number.isSafeInteger(options.embeddingDimensions) ||
      options.embeddingDimensions < 1 ||
      options.embeddingDimensions > 16_384
    ) {
      throw new Error("Persona embedding dimensions must be between 1 and 16384");
    }
    this.pool = new Pool({
      host: options.host,
      port: options.port,
      database: options.database,
      user: options.user,
      password: options.password,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ...(options.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    });
  }

  public async initialize(): Promise<void> {
    const dimensions = this.options.embeddingDimensions;
    const extension = await this.pool.query<{ installed: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS installed",
    );
    if (!extension.rows[0]?.installed) {
      throw new Error(
        "The persona memory database must be provisioned with the vector extension",
      );
    }
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS persona_turns (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        owner_key text NOT NULL,
        user_text text NOT NULL,
        assistant_text text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS persona_turns_owner_created_idx
        ON persona_turns (owner_key, created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS persona_memories (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        owner_key text NOT NULL,
        kind text NOT NULL CHECK (kind IN (
          'user_fact', 'preference', 'relationship', 'episode', 'open_loop', 'audrey_self'
        )),
        text text NOT NULL,
        normalized_text text NOT NULL,
        confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
        importance real NOT NULL CHECK (importance BETWEEN 0 AND 1),
        source_turn_id bigint NOT NULL REFERENCES persona_turns(id) ON DELETE CASCADE,
        embedding vector(${dimensions}),
        valid_from timestamptz NOT NULL DEFAULT now(),
        valid_to timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (owner_key, kind, normalized_text)
      );

      CREATE INDEX IF NOT EXISTS persona_memories_owner_active_idx
        ON persona_memories (owner_key, kind, importance DESC)
        WHERE valid_to IS NULL;
      CREATE INDEX IF NOT EXISTS persona_memories_text_idx
        ON persona_memories USING gin (to_tsvector('english', text));
      CREATE INDEX IF NOT EXISTS persona_memories_embedding_idx
        ON persona_memories USING hnsw (embedding vector_cosine_ops);

      CREATE TABLE IF NOT EXISTS persona_thoughts (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        owner_key text NOT NULL,
        source_turn_id bigint NOT NULL REFERENCES persona_turns(id) ON DELETE CASCADE,
        text text NOT NULL,
        topic text NOT NULL,
        confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
        embedding vector(${dimensions}),
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
        consumed_at timestamptz
      );

      CREATE INDEX IF NOT EXISTS persona_thoughts_owner_pending_idx
        ON persona_thoughts (owner_key, expires_at DESC)
        WHERE consumed_at IS NULL;
    `);
    this.options.logger.info("persona.memory.store.ready", {
      embeddingDimensions: dimensions,
    });
  }

  public async recentDialogue(
    ownerKey: string,
    turns: number,
  ): Promise<CelerisHistoryMessage[]> {
    const result = await this.pool.query<{
      user_text: string;
      assistant_text: string;
    }>(
      `SELECT user_text, assistant_text
       FROM (
         SELECT id, user_text, assistant_text
         FROM persona_turns
         WHERE owner_key = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2
       ) recent
       ORDER BY id ASC`,
      [ownerKey, turns],
    );
    return result.rows.flatMap(({ user_text, assistant_text }) => [
      { role: "user" as const, content: user_text },
      { role: "assistant" as const, content: assistant_text },
    ]);
  }

  public async recordTurn(
    ownerKey: string,
    user: string,
    assistant: string,
  ): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO persona_turns (owner_key, user_text, assistant_text)
       VALUES ($1, $2, $3)
       RETURNING id::text`,
      [ownerKey, user, assistant],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Persona turn insert returned no id");
    return id;
  }

  public async retrieve(
    ownerKey: string,
    query: string,
    embedding: readonly number[] | undefined,
    limit: number,
  ): Promise<PersonaMemorySelection> {
    const memoryResult = await this.pool.query<{
      id: string;
      kind: PersonaMemoryKind;
      text: string;
      confidence: number;
      importance: number;
      created_at: Date;
    }>(
      `SELECT id::text, kind, text, confidence, importance, created_at
       FROM persona_memories
       WHERE owner_key = $1 AND valid_to IS NULL
       ORDER BY (
         CASE
           WHEN $3::text IS NULL OR embedding IS NULL THEN 0
           ELSE (1 - (embedding <=> $3::vector)) * 0.60
         END
         + ts_rank_cd(to_tsvector('english', text), websearch_to_tsquery('english', $2)) * 0.20
         + importance * 0.15
         + (1 / (1 + extract(epoch FROM (now() - updated_at)) / 2592000)) * 0.05
       ) DESC, updated_at DESC
       LIMIT $4`,
      [ownerKey, query, vectorLiteral(embedding), limit],
    );

    const thoughtResult = await this.pool.query<{
      id: string;
      text: string;
      topic: string;
      confidence: number;
      similarity: number | null;
    }>(
      `SELECT id::text, text, topic, confidence,
         CASE
           WHEN $2::text IS NULL OR embedding IS NULL THEN NULL
           ELSE 1 - (embedding <=> $2::vector)
         END AS similarity
       FROM persona_thoughts
       WHERE owner_key = $1
         AND consumed_at IS NULL
         AND expires_at > now()
       ORDER BY similarity DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      [ownerKey, vectorLiteral(embedding)],
    );
    const thought = thoughtResult.rows[0];
    const selectedThought = thought &&
      thought.confidence >= 0.65 &&
      (thought.similarity === null || thought.similarity >= 0.35)
      ? {
          id: thought.id,
          text: thought.text,
          topic: thought.topic,
          confidence: thought.confidence,
        }
      : undefined;
    return {
      memories: memoryResult.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        text: row.text,
        confidence: row.confidence,
        importance: row.importance,
        createdAt: row.created_at.toISOString(),
      })),
      ...(selectedThought ? { thought: selectedThought } : {}),
    };
  }

  public async saveAnalysis(
    ownerKey: string,
    turnId: string,
    analysis: PersonaTurnAnalysis,
    memoryEmbeddings: readonly (readonly number[] | undefined)[],
    thoughtEmbedding: readonly number[] | undefined,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [index, memory] of analysis.memories.entries()) {
        const normalized = normalizedMemoryText(memory.text);
        if (!normalized) continue;
        await client.query(
          `INSERT INTO persona_memories (
             owner_key, kind, text, normalized_text, confidence, importance,
             source_turn_id, embedding
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)
           ON CONFLICT (owner_key, kind, normalized_text) DO UPDATE SET
             confidence = GREATEST(persona_memories.confidence, EXCLUDED.confidence),
             importance = GREATEST(persona_memories.importance, EXCLUDED.importance),
             source_turn_id = EXCLUDED.source_turn_id,
             embedding = COALESCE(EXCLUDED.embedding, persona_memories.embedding),
             valid_to = NULL,
             updated_at = now()`,
          [
            ownerKey,
            memory.kind,
            memory.text,
            normalized,
            boundedScore(memory.confidence, 0.5),
            boundedScore(memory.importance, 0.5),
            turnId,
            vectorLiteral(memoryEmbeddings[index]),
          ],
        );
      }
      if (analysis.thought) {
        await client.query(
          `INSERT INTO persona_thoughts (
             owner_key, source_turn_id, text, topic, confidence, embedding
           ) VALUES ($1, $2, $3, $4, $5, $6::vector)`,
          [
            ownerKey,
            turnId,
            analysis.thought.text,
            analysis.thought.topic,
            boundedScore(analysis.thought.confidence, 0.5),
            vectorLiteral(thoughtEmbedding),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async consumeThought(ownerKey: string, thoughtId: string): Promise<void> {
    await this.pool.query(
      `UPDATE persona_thoughts
       SET consumed_at = now()
       WHERE id = $1 AND owner_key = $2 AND consumed_at IS NULL`,
      [thoughtId, ownerKey],
    );
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}

export interface OllamaPersonaEmbedderOptions {
  baseUrl: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
}

export class OllamaPersonaEmbedder implements PersonaEmbedder {
  public constructor(private readonly options: OllamaPersonaEmbedderOptions) {}

  public async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.options.model, input: texts }),
        signal: signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal,
      });
      if (!response.ok) throw new Error(`Embedding service returned HTTP ${response.status}`);
      const payload = (await response.json()) as { embeddings?: unknown };
      if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== texts.length) {
        throw new Error("Embedding service returned the wrong number of vectors");
      }
      return payload.embeddings.map((raw) => {
        if (
          !Array.isArray(raw) ||
          raw.length !== this.options.dimensions ||
          raw.some((value) => typeof value !== "number" || !Number.isFinite(value))
        ) {
          throw new Error("Embedding service returned an invalid vector");
        }
        return raw as number[];
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface OpenAiPersonaAdviserOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  model: string;
  analysisModel?: string | undefined;
  timeoutMs: number;
  logger: Logger;
}

const analysisSchema = {
  name: "persona_turn_analysis",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      memories: {
        type: "array",
        maxItems: 6,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: personaMemoryKinds },
            text: { type: "string" },
            confidence: { type: "number" },
            importance: { type: "number" },
          },
          required: ["kind", "text", "confidence", "importance"],
        },
      },
      thought: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string" },
              topic: { type: "string" },
              confidence: { type: "number" },
            },
            required: ["text", "topic", "confidence"],
          },
        ],
      },
    },
    required: ["memories", "thought"],
  },
} as const;

const isMemoryKind = (value: unknown): value is PersonaMemoryKind =>
  typeof value === "string" && (personaMemoryKinds as readonly string[]).includes(value);

const cleanText = (value: unknown, maximum: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maximum) : undefined;
};

export class OpenAiPersonaAdviser implements PersonaAdviser {
  public constructor(private readonly options: OpenAiPersonaAdviserOptions) {}

  public async analyzeTurn(user: string, assistant: string): Promise<PersonaTurnAnalysis> {
    const content = await this.complete(
      [
        {
          role: "system",
          content:
            "You are a precision memory and conversation-reflection worker for a private spoken companion. " +
            "Store only information explicitly stated in the supplied dialogue and useful in a future personal conversation. " +
            "Never add sensory details, motives, emotions, causes, names, experiences, or implications that were not stated. " +
            "Facts about the human come only from the user text. Audrey's own expressed preference may use audrey_self, " +
            "but a polite reaction is not a durable preference. Use one short atomic sentence per memory. " +
            "A thought is a private, short-lived idea that could improve a related future turn: a callback, better joke, " +
            "gentle question, or useful conversational angle. It is a suggestion, never a fact. Return null when none is worthwhile.",
        },
        {
          role: "user",
          content: JSON.stringify({ user, assistant }),
        },
      ],
      384,
      { type: "json_schema", json_schema: analysisSchema },
      this.options.analysisModel ?? this.options.model,
      "analysis",
    );
    const parsed = JSON.parse(content) as { memories?: unknown; thought?: unknown };
    const memories = Array.isArray(parsed.memories)
      ? parsed.memories.flatMap((raw): PersonaMemoryCandidate[] => {
          if (!raw || typeof raw !== "object") return [];
          const candidate = raw as Record<string, unknown>;
          const text = cleanText(candidate.text, 500);
          if (!isMemoryKind(candidate.kind) || !text) return [];
          return [{
            kind: candidate.kind,
            text,
            confidence: boundedScore(Number(candidate.confidence), 0.5),
            importance: boundedScore(Number(candidate.importance), 0.5),
          }];
        }).slice(0, 6)
      : [];
    let thought: PersonaThoughtCandidate | undefined;
    if (parsed.thought && typeof parsed.thought === "object") {
      const raw = parsed.thought as Record<string, unknown>;
      const text = cleanText(raw.text, 500);
      const topic = cleanText(raw.topic, 160);
      if (text && topic) {
        thought = {
          text,
          topic,
          confidence: boundedScore(Number(raw.confidence), 0.5),
        };
      }
    }
    return { memories, ...(thought ? { thought } : {}) };
  }

  public async advise(
    request: string,
    context: {
      memories: readonly PersonaMemoryRecord[];
      recentDialogue: readonly CelerisHistoryMessage[];
    },
  ): Promise<string> {
    return this.complete(
      [
        {
          role: "system",
          content:
            "You are the private creative adviser for Audrey, a playful, perceptive spoken companion. " +
            "Produce one strong, concise response idea grounded only in the request and supplied context. " +
            "Do not claim actions or memories that are absent. Return plain spoken wording with no preamble or analysis.",
        },
        {
          role: "user",
          content: JSON.stringify({
            request,
            relevant_memories: context.memories.map(({ kind, text }) => ({ kind, text })),
            recent_dialogue: context.recentDialogue.slice(-12),
          }),
        },
      ],
      192,
      undefined,
      this.options.model,
      "advice",
    );
  }

  private async complete(
    messages: Array<{ role: "system" | "user"; content: string }>,
    maxTokens: number,
    responseFormat?: Record<string, unknown>,
    model = this.options.model,
    phase = "unknown",
  ): Promise<string> {
    const started = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(
        `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.options.apiKey
              ? { authorization: `Bearer ${this.options.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0,
            max_completion_tokens: maxTokens,
            reasoning_effort: "low",
            ...(responseFormat ? { response_format: responseFormat } : {}),
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error(`Persona adviser returned HTTP ${response.status}`);
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("Persona adviser returned no content");
      }
      this.options.logger.info("persona.adviser.usage", {
        phase,
        durationMs: Math.round(performance.now() - started),
        promptTokens:
          typeof payload.usage?.prompt_tokens === "number"
            ? payload.usage.prompt_tokens
            : undefined,
        completionTokens:
          typeof payload.usage?.completion_tokens === "number"
            ? payload.usage.completion_tokens
            : undefined,
      });
      return content.trim();
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface PersonaMemoryRuntimeOptions {
  ownerKey: string;
  store: PersonaMemoryStore;
  embedder: PersonaEmbedder;
  adviser: PersonaAdviser;
  logger: Logger;
  retrievalLimit?: number | undefined;
  restoreTurns?: number | undefined;
}

interface PreparedMemory {
  normalizedQuery: string;
  selection: PersonaMemorySelection;
}

const relatedQuery = (prepared: string, current: string): boolean =>
  prepared.length >= 8 &&
  current.length >= 8 &&
  (prepared.startsWith(current) || current.startsWith(prepared));

export class PersonaMemoryRuntime {
  private prepared: PreparedMemory | undefined;
  private prepareGeneration = 0;
  private prepareController: AbortController | undefined;
  private backgroundTail: Promise<void> = Promise.resolve();
  private readonly retrievalLimit: number;
  private readonly restoreTurns: number;

  public constructor(private readonly options: PersonaMemoryRuntimeOptions) {
    this.retrievalLimit = options.retrievalLimit ?? 6;
    this.restoreTurns = options.restoreTurns ?? 12;
  }

  public async initialize(): Promise<CelerisHistoryMessage[]> {
    await this.options.store.initialize();
    const warmupStarted = performance.now();
    await this.options.embedder.embed(["private companion memory warmup"]);
    this.options.logger.info("persona.memory.embedding.warmed", {
      durationMs: Math.round(performance.now() - warmupStarted),
    });
    const history = await this.options.store.recentDialogue(
      this.options.ownerKey,
      this.restoreTurns,
    );
    this.options.logger.info("persona.memory.ready", {
      restoredMessages: history.length,
    });
    return history;
  }

  public prepare(input: string): void {
    const query = input.replace(/\s+/g, " ").trim();
    const normalizedQuery = normalizedMemoryText(query);
    if (normalizedQuery.length < 8) return;
    const generation = ++this.prepareGeneration;
    this.prepareController?.abort();
    const controller = new AbortController();
    this.prepareController = controller;
    const started = performance.now();
    void this.options.embedder
      .embed([query], controller.signal)
      .then(([embedding]) =>
        this.options.store.retrieve(
          this.options.ownerKey,
          query,
          embedding,
          this.retrievalLimit,
        ),
      )
      .then((selection) => {
        if (generation !== this.prepareGeneration || controller.signal.aborted) return;
        this.prepared = { normalizedQuery, selection };
        this.options.logger.info("persona.memory.prefetch.ready", {
          durationMs: Math.round(performance.now() - started),
          memories: selection.memories.length,
          thoughtReady: Boolean(selection.thought),
        });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        this.options.logger.error("persona.memory.prefetch.failed", error);
      });
  }

  public contextFor(input: string): string | undefined {
    const normalizedQuery = normalizedMemoryText(input);
    const prepared = this.prepared;
    this.prepare(input);
    if (!prepared || !relatedQuery(prepared.normalizedQuery, normalizedQuery)) {
      this.options.logger.info("persona.memory.snapshot", {
        ready: false,
        memories: 0,
        thoughtReady: false,
      });
      return undefined;
    }
    this.options.logger.info("persona.memory.snapshot", {
      ready: true,
      memories: prepared.selection.memories.length,
      thoughtReady: Boolean(prepared.selection.thought),
    });
    if (prepared.selection.thought) {
      void this.options.store
        .consumeThought(this.options.ownerKey, prepared.selection.thought.id)
        .catch((error) => this.options.logger.error("persona.thought.consume.failed", error));
    }
    if (prepared.selection.memories.length === 0 && !prepared.selection.thought) {
      return undefined;
    }
    return JSON.stringify({
      relevant_memories: prepared.selection.memories.map((memory) => ({
        kind: memory.kind,
        text: memory.text,
        confidence: memory.confidence,
        recorded_at: memory.createdAt,
      })),
      ...(prepared.selection.thought
        ? {
            optional_private_thought: {
              text: prepared.selection.thought.text,
              topic: prepared.selection.thought.topic,
              confidence: prepared.selection.thought.confidence,
            },
          }
        : {}),
    });
  }

  public rememberTurn(user: string, assistant: string): void {
    this.backgroundTail = this.backgroundTail
      .then(() => this.processTurn(user, assistant))
      .catch((error) => this.options.logger.error("persona.memory.turn.failed", error));
  }

  public async askAdviser(
    request: string,
    recentDialogue: readonly CelerisHistoryMessage[],
  ): Promise<string> {
    let memories: PersonaMemoryRecord[] = [];
    try {
      const [embedding] = await this.options.embedder.embed([request]);
      const selection = await this.options.store.retrieve(
        this.options.ownerKey,
        request,
        embedding,
        this.retrievalLimit,
      );
      memories = selection.memories;
    } catch (error) {
      this.options.logger.error("persona.adviser.memory.failed", error);
    }
    return this.options.adviser.advise(request, { memories, recentDialogue });
  }

  public async close(): Promise<void> {
    this.prepareController?.abort();
    await this.backgroundTail;
    await this.options.store.close();
  }

  private async processTurn(user: string, assistant: string): Promise<void> {
    const started = performance.now();
    const turnId = await this.options.store.recordTurn(
      this.options.ownerKey,
      user,
      assistant,
    );
    const analysis = await this.options.adviser.analyzeTurn(user, assistant);
    const texts = [
      ...analysis.memories.map((memory) => memory.text),
      ...(analysis.thought ? [analysis.thought.topic] : []),
    ];
    const embeddings = texts.length > 0
      ? await this.options.embedder.embed(texts)
      : [];
    const memoryEmbeddings = embeddings.slice(0, analysis.memories.length);
    const thoughtEmbedding = analysis.thought
      ? embeddings[analysis.memories.length]
      : undefined;
    await this.options.store.saveAnalysis(
      this.options.ownerKey,
      turnId,
      analysis,
      memoryEmbeddings,
      thoughtEmbedding,
    );
    this.options.logger.info("persona.memory.turn.processed", {
      durationMs: Math.round(performance.now() - started),
      memories: analysis.memories.length,
      thoughtCreated: Boolean(analysis.thought),
    });
  }
}
