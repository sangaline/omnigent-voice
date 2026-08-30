import pg from "pg";
import {
  consumeCompletionStream,
  type CelerisHistoryMessage,
} from "./celeris.js";
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
export type PersonaMemorySource = "user" | "assistant";

export interface PersonaMemoryCandidate {
  kind: PersonaMemoryKind;
  canonicalKey: string;
  text: string;
  source: PersonaMemorySource;
  evidenceQuote: string;
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

export interface PersonaTurnPlan {
  draftReply: string;
  memoryAnchor: string;
  memoryAnchorDecided: boolean;
  interpretation: string;
  relevantFacts: string[];
  responseStrategy: string;
  responseIdeas: string[];
  needsAdviser: boolean;
  shouldClarify: boolean;
}

export interface PersonaMemoryRecord
  extends Omit<PersonaMemoryCandidate, "source" | "evidenceQuote"> {
  id: string;
  createdAt: string;
  source: PersonaMemorySource | "legacy";
  evidenceQuote: string;
  relevance?: number | undefined;
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
  planTurn(
    partialInput: string,
    context: {
      memories: readonly PersonaMemoryRecord[];
      thought?: PersonaThoughtRecord | undefined;
      recentDialogue: readonly CelerisHistoryMessage[];
    },
    onPartial?: ((plan: PersonaTurnPlan) => void) | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<PersonaTurnPlan>;
  advise(
    request: string,
    context: {
      memories: readonly PersonaMemoryRecord[];
      recentDialogue: readonly CelerisHistoryMessage[];
    },
    onPartial?: ((fragment: string) => void) | undefined,
    signal?: AbortSignal | undefined,
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
        canonical_key text,
        evidence_speaker text,
        evidence_quote text,
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
    await this.pool.query(`
      ALTER TABLE persona_memories
        ADD COLUMN IF NOT EXISTS canonical_key text,
        ADD COLUMN IF NOT EXISTS evidence_speaker text,
        ADD COLUMN IF NOT EXISTS evidence_quote text;

      UPDATE persona_memories
      SET canonical_key = kind || ':legacy:' || id::text,
          evidence_speaker = 'legacy',
          evidence_quote = text
      WHERE canonical_key IS NULL
         OR evidence_speaker IS NULL
         OR evidence_quote IS NULL;

      ALTER TABLE persona_memories
        ALTER COLUMN canonical_key SET NOT NULL,
        ALTER COLUMN evidence_speaker SET NOT NULL,
        ALTER COLUMN evidence_quote SET NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS persona_memories_owner_canonical_active_idx
        ON persona_memories (owner_key, canonical_key)
        WHERE valid_to IS NULL;
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
      canonical_key: string;
      evidence_speaker: PersonaMemorySource | "legacy";
      evidence_quote: string;
      confidence: number;
      importance: number;
      retrieval_relevance: number;
      created_at: Date;
    }>(
      `SELECT id::text, kind, canonical_key, text, evidence_speaker,
              evidence_quote, confidence, importance, created_at,
              GREATEST(
                semantic_similarity,
                CASE WHEN lexical_similarity > 0 THEN 0.75 ELSE 0 END
              ) AS retrieval_relevance
       FROM (
         SELECT *,
           CASE
             WHEN $3::text IS NULL OR embedding IS NULL THEN 0
             ELSE 1 - (embedding <=> $3::vector)
           END AS semantic_similarity,
           ts_rank_cd(
             to_tsvector('english', text),
             websearch_to_tsquery('english', $2)
           ) AS lexical_similarity
         FROM persona_memories
         WHERE owner_key = $1 AND valid_to IS NULL
       ) ranked
       WHERE semantic_similarity >= $5 OR lexical_similarity > 0
       ORDER BY (
         semantic_similarity * 0.60
         + lexical_similarity * 0.20
         + importance * 0.15
         + (1 / (1 + extract(epoch FROM (now() - updated_at)) / 2592000)) * 0.05
       ) DESC, updated_at DESC
       LIMIT $4`,
      [ownerKey, query, vectorLiteral(embedding), limit, 0.4],
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
      thought.confidence >= 0.55 &&
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
        canonicalKey: row.canonical_key,
        text: row.text,
        source: row.evidence_speaker,
        evidenceQuote: row.evidence_quote,
        confidence: row.confidence,
        importance: row.importance,
        relevance: row.retrieval_relevance,
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
          `UPDATE persona_memories
           SET valid_to = now(), updated_at = now()
           WHERE owner_key = $1 AND canonical_key = $2 AND valid_to IS NULL`,
          [ownerKey, memory.canonicalKey],
        );
        await client.query(
          `INSERT INTO persona_memories (
             owner_key, kind, text, normalized_text, canonical_key,
             evidence_speaker, evidence_quote, confidence, importance,
             source_turn_id, embedding
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector)
           ON CONFLICT (owner_key, kind, normalized_text) DO UPDATE SET
             canonical_key = EXCLUDED.canonical_key,
             text = EXCLUDED.text,
             evidence_speaker = EXCLUDED.evidence_speaker,
             evidence_quote = EXCLUDED.evidence_quote,
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
            memory.canonicalKey,
            memory.source,
            memory.evidenceQuote,
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
            canonical_key: { type: "string" },
            text: { type: "string" },
            source: { type: "string", enum: ["user", "assistant"] },
            evidence_quote: { type: "string" },
            confidence: { type: "number" },
            importance: { type: "number" },
          },
          required: [
            "kind",
            "canonical_key",
            "text",
            "source",
            "evidence_quote",
            "confidence",
            "importance",
          ],
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

const turnPlanSchema = {
  name: "persona_turn_plan",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      memory_anchor: { type: "string", maxLength: 80 },
      draft_reply: { type: "string", maxLength: 300 },
      alternate_reply_1: { type: "string", maxLength: 300 },
      alternate_reply_2: { type: "string", maxLength: 300 },
    },
    required: ["memory_anchor", "draft_reply", "alternate_reply_1", "alternate_reply_2"],
  },
} as const;

const creativeAdviceSchema = {
  name: "persona_creative_candidates",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      candidates: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: { type: "string", maxLength: 300 },
      },
    },
    required: ["candidates"],
  },
} as const;

const isMemoryKind = (value: unknown): value is PersonaMemoryKind =>
  typeof value === "string" && (personaMemoryKinds as readonly string[]).includes(value);

const cleanText = (value: unknown, maximum: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maximum) : undefined;
};

const cleanCanonicalKey = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const key = value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return key || undefined;
};

const evidenceAppearsIn = (quote: string, source: string): boolean => {
  const normalizedQuote = normalizedMemoryText(quote);
  return normalizedQuote.length >= 2 && normalizedMemoryText(source).includes(normalizedQuote);
};

const firstPersonEvidence = (quote: string): boolean =>
  /\b(?:i|i'm|i've|i'd|i'll|me|my|mine|we|we're|we've|our|ours|us|call me)\b/i.test(quote);

const claimedName = (text: string): string | undefined => {
  const match = /\b(?:name is|named|goes by)\s+([\p{L}\p{M}'-]+(?:\s+[\p{L}\p{M}'-]+){0,2})(?=[.!?,;:]|$)/iu.exec(
    text,
  );
  return match?.[1]?.replace(/\s+/g, " ").trim();
};

const transientSystemFeedback = (text: string): boolean =>
  /\b(?:latency|response time|lag|turnaround|first audio|faster response|slower response)\b/i.test(
    text,
  );

const partialJsonString = (content: string, key: string): string | undefined => {
  const match = new RegExp(`"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`).exec(
    content,
  );
  if (!match?.[1]) return undefined;
  try {
    return cleanText(JSON.parse(match[1]), 400);
  } catch {
    return undefined;
  }
};

const partialJsonStringAllowEmpty = (
  content: string,
  key: string,
): { decided: boolean; value: string } => {
  const match = new RegExp(`"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`).exec(
    content,
  );
  if (!match?.[1]) return { decided: false, value: "" };
  try {
    const parsed = JSON.parse(match[1]);
    return {
      decided: typeof parsed === "string",
      value: typeof parsed === "string" ? parsed.replace(/\s+/g, " ").trim().slice(0, 80) : "",
    };
  } catch {
    return { decided: false, value: "" };
  }
};

export const creativeExplanationRequest = (input: string): boolean =>
  /\bexplain\b[\s\S]{0,50}\b(?:joke|punchline|story|poem|roast)\b/i.test(input) ||
  /\b(?:what(?:'s| is| was) the joke|what (?:did|does) (?:that|the joke) mean|why (?:is|was) (?:that|it) funny)\b/i.test(
    input,
  );

const creativePersonaRequest = (input: string): boolean =>
  !creativeExplanationRequest(input) &&
  /\b(?:joke|punchline|make me laugh|tell me a story|poem|roast|(?:distract|entertain|amuse) me|cheer me up)\b/i.test(
    input,
  );

export const selfContainedPersonaRequest = (input: string): boolean =>
  /\b(?:give me|tell me|say something|make me|(?:distract|entertain|amuse) me|cheer me up|your (?:honest )?(?:read|opinion|take)|one tiny reset)\b/i.test(
    input,
  ) ||
  (/\b(?:i(?:'m| am) bored|brain is mush)\b/i.test(input) &&
    /\b(?:don'?t|do not)\b[\s\S]{0,80}\b(?:pick|questions?|topic)\b/i.test(input));

const jokePersonaRequest = (input: string): boolean =>
  /\b(?:joke|punchline|make me laugh)\b/i.test(input);

export const usefulPersonaThought = (text: string): boolean => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.includes("?")) return false;
  return !/\b(?:ask(?:ing)? (?:the user|them|if)|invit(?:e|ing) (?:the user|them)|steer(?:ing)? (?:back|away)|what (?:they|the user)(?:'d| would) like|if (?:they|the user) (?:have|want)|tell me something|share (?:a )?(?:new )?fact|test (?:your|the) memory|want(?:s)? (?:Audrey|her) to remember|offer to remember)\b/i.test(
    normalized,
  );
};

export const groundedMemoryCandidate = (
  raw: Record<string, unknown>,
  user: string,
  assistant: string,
): PersonaMemoryCandidate | undefined => {
  const kind = raw.kind;
  const canonicalKey = cleanCanonicalKey(raw.canonical_key);
  const text = cleanText(raw.text, 500);
  const source = raw.source === "user" || raw.source === "assistant"
    ? raw.source
    : undefined;
  const evidenceQuote = cleanText(raw.evidence_quote, 500);
  if (!isMemoryKind(kind) || !canonicalKey || !text || !source || !evidenceQuote) {
    return undefined;
  }
  if (kind === "audrey_self" && source !== "assistant") return undefined;
  if (kind !== "audrey_self" && source !== "user") return undefined;
  if (!evidenceAppearsIn(evidenceQuote, source === "user" ? user : assistant)) {
    return undefined;
  }
  if (source === "user" && !firstPersonEvidence(evidenceQuote)) return undefined;
  if (source === "user" && transientSystemFeedback(`${text} ${evidenceQuote}`)) {
    return undefined;
  }
  if (canonicalKey === "user.name") {
    const name = claimedName(text);
    if (!name || !normalizedMemoryText(evidenceQuote).includes(normalizedMemoryText(name))) {
      return undefined;
    }
  }
  return {
    kind,
    canonicalKey,
    text,
    source,
    evidenceQuote,
    confidence: boundedScore(Number(raw.confidence), 0.5),
    importance: boundedScore(Number(raw.importance), 0.5),
  };
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
            "but a polite reaction is not a durable preference. Every memory must identify its source speaker and copy a " +
            "short exact evidence quote from that speaker. Use a stable semantic canonical_key such as user.name, " +
            "user.preference.rain, shared.episode.pottery, or audrey.preference.music so corrections replace stale values. " +
            "Use one short atomic sentence per memory. " +
            "A thought is a private, short-lived idea that could improve a related future turn: a specific callback, " +
            "concrete observation, fresh contribution, or useful conversational angle. It is a suggestion, never a fact. " +
            "Never make the thought a question, an instruction to ask or invite the human, a memory test, a generic offer " +
            "to remember something, or a suggestion to steer away from a direct mechanism question. Return null when no " +
            "specific substantive contribution is worthwhile. " +
            "Always retain an explicitly stated preferred name, changed preference, future plan, appointment, promised follow-up, " +
            "or unresolved event. When one event is resolved and the human states a dated next step, store that new next step as " +
            "an open_loop and preserve the exact day in its text and evidence. " +
            "Do not store transient feedback about latency, response speed, model behavior, or system testing as a durable " +
            "human fact. A short fragment such as 'a decent memory' is not a human fact unless it explicitly refers to the " +
            "human in first person. A question, hypothetical, joke premise, fictional material spoken by Audrey, or false " +
            "shared-memory test is not evidence that an event happened. " +
            "If Audrey denies a purported event, do not extract that event as memory.",
        },
        {
          role: "user",
          content: JSON.stringify({ user, assistant }),
        },
      ],
      768,
      { type: "json_schema", json_schema: analysisSchema },
      this.options.analysisModel ?? this.options.model,
      "analysis",
    );
    const parsed = JSON.parse(content) as { memories?: unknown; thought?: unknown };
    const memories = Array.isArray(parsed.memories)
      ? parsed.memories.flatMap((raw): PersonaMemoryCandidate[] => {
          if (!raw || typeof raw !== "object") return [];
          const candidate = groundedMemoryCandidate(
            raw as Record<string, unknown>,
            user,
            assistant,
          );
          return candidate ? [candidate] : [];
        }).slice(0, 6)
      : [];
    let thought: PersonaThoughtCandidate | undefined;
    if (parsed.thought && typeof parsed.thought === "object") {
      const raw = parsed.thought as Record<string, unknown>;
      const text = cleanText(raw.text, 500);
      const topic = cleanText(raw.topic, 160);
      if (text && topic && usefulPersonaThought(text)) {
        thought = {
          text,
          topic,
          confidence: boundedScore(Number(raw.confidence), 0.5),
        };
      }
    }
    return { memories, ...(thought ? { thought } : {}) };
  }

  public async planTurn(
    partialInput: string,
    context: {
      memories: readonly PersonaMemoryRecord[];
      thought?: PersonaThoughtRecord | undefined;
      recentDialogue: readonly CelerisHistoryMessage[];
    },
    onPartial?: ((plan: PersonaTurnPlan) => void) | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<PersonaTurnPlan> {
    const creativeRequest = creativePersonaRequest(partialInput);
    let streamedContent = "";
    let lastPartialInterpretation: string | undefined;
    const content = await this.complete(
      [
        {
          role: "system",
          content:
            "You prepare one just-in-time reply for Audrey, a realistic spoken companion. " +
            "The current speech transcript may be partial or contain ASR substitutions. Infer its likely meaning from " +
            "the recent chronological dialogue, especially phonetically plausible names such as DeepSeek becoming deep sea. " +
            "Return memory_anchor first, then draft_reply and two alternate reply fields. For an ordinary turn, put the strongest complete spoken " +
            "reply in draft_reply and return empty alternate strings. For a joke, humor, story, poem, or roast request, " +
            "write three genuinely distinct candidates, strongest first. Every nonempty reply must be in Audrey's natural voice, usually " +
            "one or two concise sentences. Set memory_anchor to one to three exact distinctive words copied from a selected " +
            "memory only when that memory is clearly relevant to the current speech and would make a natural subtle callback; " +
            "the draft must contain those words. Otherwise set memory_anchor to an empty string and do not force any memory. " +
            "Preserve the exact named person, event, preference, correction, or emotional " +
            "open loop needed to demonstrate continuity. Trust the newest speech over stale memory. Fulfill direct requests " +
            "inside the reply: if asked to distract or entertain, provide the distraction instead of asking the human for " +
            "another task. If asked to give, tell, say, make, distract, entertain, or offer an honest read, the reply must " +
            "deliver that contribution and must not turn it into a question. A distraction reply must be a self-contained " +
            "amusing observation, tiny story, or playful riff, not a question or conversation prompt. If an optional " +
            "background thought directly supplies the requested contribution, use its specific image or idea instead of " +
            "replacing it with an unrelated one. Resolve conversational shorthand before writing: when the human says something like today's " +
            "the day, it happened, or that one, name the concrete event from recent dialogue or an open-loop memory. For " +
            "example, if the established event is an interview, say interview rather than giving generic encouragement. " +
            "Respond to nerves with specific continuity rather than a stock pep talk. For jokes or creative requests, " +
            "write fresh material rather than a familiar joke template or internet chestnut. Keep fictional humor clearly " +
            "fictional; never package an invented anecdote, study, historical event, or animal fact as true trivia. Never invent visual activity, sensory access, physical co-presence, shared possessions, external " +
            "actions, events, or relationship history. If the likely meaning remains genuinely ambiguous, ask one brief " +
            "clarifying question in draft_reply rather than guessing.",
        },
        {
          role: "user",
          content: JSON.stringify({
            partial_current_speech: partialInput,
            recent_dialogue: context.recentDialogue.slice(-16),
            selected_memories: context.memories.map(({ kind, canonicalKey, text, confidence, relevance }) => ({
              kind,
              canonical_key: canonicalKey,
              text,
              confidence,
              ...(relevance !== undefined ? { retrieval_relevance: relevance } : {}),
            })),
            required_continuity_terms_if_relevant: memoryContinuityAnchors(
              context.memories,
            ),
            ...(context.thought
              ? {
                  optional_background_thought: {
                    text: context.thought.text,
                    topic: context.thought.topic,
                    confidence: context.thought.confidence,
                  },
                }
              : {}),
            verified_runtime_facts: [
              "Audrey is a speech-only companion with no visual interface or sensory access.",
              "Selected memories and private background suggestions can be injected into her turn context.",
              "She cannot perform external actions in persona mode.",
            ],
            ...(creativeRequest
              ? {
                  creative_constraints: [
                    "Under 45 spoken words.",
                    "Clearly fictional, not alleged trivia or personal experience.",
                    "No walks-into-a-bar-or-library setup, famous joke, or stock template.",
                    "Prefer one specific surreal image and a clean turn or punchline.",
                  ],
                }
              : {}),
          }),
        },
      ],
      creativeRequest ? 384 : 192,
      { type: "json_schema", json_schema: turnPlanSchema },
      this.options.model,
      creativeRequest ? "turn_plan_creative" : "turn_plan",
      (fragment) => {
        streamedContent += fragment;
        const draftReply = partialJsonString(streamedContent, "draft_reply");
        const memoryAnchor = partialJsonStringAllowEmpty(
          streamedContent,
          "memory_anchor",
        );
        const alternatives = [
          partialJsonString(streamedContent, "alternate_reply_1"),
          partialJsonString(streamedContent, "alternate_reply_2"),
        ].filter((value): value is string => Boolean(value));
        const partialKey = `${draftReply ?? ""}\n${memoryAnchor.decided}:${memoryAnchor.value}\n${alternatives.join("\n")}`;
        if (!draftReply || partialKey === lastPartialInterpretation) return;
        lastPartialInterpretation = partialKey;
        onPartial?.({
          draftReply,
          memoryAnchor: memoryAnchor.value,
          memoryAnchorDecided: memoryAnchor.decided,
          interpretation: partialInput,
          relevantFacts: [],
          responseStrategy: "Use the prepared reply if the completed transcript still matches.",
          responseIdeas: alternatives,
          needsAdviser: false,
          shouldClarify: false,
        });
      },
      signal,
    );
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const draftReply = cleanText(parsed.draft_reply, 500) ?? "";
    const memoryAnchor = cleanText(parsed.memory_anchor, 80) ?? "";
    const responseIdeas = [parsed.alternate_reply_1, parsed.alternate_reply_2]
      .flatMap((value) => {
        const text = cleanText(value, 500);
        return text ? [text] : [];
      });
    return {
      draftReply,
      memoryAnchor,
      memoryAnchorDecided: true,
      interpretation: partialInput,
      relevantFacts: [],
      responseStrategy: "Use the prepared reply if the completed transcript still matches.",
      responseIdeas,
      needsAdviser: false,
      shouldClarify: false,
    };
  }

  public async advise(
    request: string,
    context: {
      memories: readonly PersonaMemoryRecord[];
      recentDialogue: readonly CelerisHistoryMessage[];
    },
    onPartial?: ((fragment: string) => void) | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<string> {
    const creativeRequest = creativePersonaRequest(request);
    const messages: Array<{ role: "system" | "user"; content: string }> = [
        {
          role: "system",
          content:
            "You are the private creative adviser for Audrey, a playful, perceptive spoken companion. " +
            "For humor or another creative request, avoid famous jokes, familiar internet chestnuts, generic templates, " +
            "and obvious puns unless the human asks for them. For a joke or other explicit creative request, write exactly " +
            "three genuinely distinct candidates under forty-five spoken words each so the harness can reject weak material. " +
            "Otherwise write one strongest, genuinely fresh, concise final reply " +
            "with specific imagery in Audrey's natural spoken voice. For emotional or factual reflection, be precise. " +
            "For a direct joke request, start every candidate with 'Imagine' or 'Picture this' so invented material is unmistakably fictional. " +
            "Keep fictional humor clearly fictional; never present an invented anecdote, study, historical event, or animal " +
            "fact as true trivia. Do not claim actions, sensory access, or memories that are absent. Return only the complete words Audrey " +
            "should speak, with no alternatives, preamble, or analysis.",
        },
        {
          role: "user",
          content: JSON.stringify({
            request,
            relevant_memories: context.memories.map(({ kind, text }) => ({ kind, text })),
            recent_dialogue: context.recentDialogue.slice(-12),
          }),
        },
      ];
    if (creativeRequest) {
      const content = await this.complete(
        messages,
        384,
        { type: "json_schema", json_schema: creativeAdviceSchema },
        this.options.model,
        "advice",
        undefined,
        signal,
      );
      const parsed = JSON.parse(content) as { candidates?: unknown };
      const candidates = Array.isArray(parsed.candidates)
        ? parsed.candidates.flatMap((value) => {
            const text = cleanText(value, 500);
            return text ? [text] : [];
          })
        : [];
      const selected = candidates.find((candidate) =>
        !unsafeCreativeDraft(request, candidate));
      if (!selected) throw new Error("Persona adviser returned no safe creative candidate");
      onPartial?.(selected);
      return selected;
    }
    return this.complete(
      messages,
      192,
      undefined,
      this.options.model,
      "advice",
      onPartial,
      signal,
    );
  }

  private async complete(
    messages: Array<{ role: "system" | "user"; content: string }>,
    maxTokens: number,
    responseFormat?: Record<string, unknown>,
    model = this.options.model,
    phase = "unknown",
    onContentDelta?: ((fragment: string) => void) | undefined,
    externalSignal?: AbortSignal | undefined,
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
            temperature: phase === "advice" || phase === "turn_plan_creative" ? 0.7 : 0,
            max_completion_tokens: maxTokens,
            // Pareto's OpenAI-compatible DeepSeek endpoint accepts `none` to
            // disable the otherwise expensive reasoning pass. These bounded
            // companion jobs need low latency and explicit output instead.
            reasoning_effort: "none",
            ...(responseFormat ? { response_format: responseFormat } : {}),
            ...(onContentDelta
              ? { stream: true, stream_options: { include_usage: true } }
              : {}),
          }),
          signal: externalSignal
            ? AbortSignal.any([controller.signal, externalSignal])
            : controller.signal,
        },
      );
      if (!response.ok) throw new Error(`Persona adviser returned HTTP ${response.status}`);
      if (
        onContentDelta &&
        response.headers.get("content-type")?.toLocaleLowerCase().includes(
          "text/event-stream",
        )
      ) {
        const streamed = await consumeCompletionStream(response, onContentDelta);
        const content = streamed.message.content;
        if (typeof content !== "string" || !content.trim()) {
          throw new Error("Persona adviser returned no content");
        }
        this.options.logger.info("persona.adviser.usage", {
          phase,
          durationMs: Math.round(performance.now() - started),
          promptTokens: streamed.promptTokens,
          completionTokens: streamed.completionTokens,
          streamed: true,
        });
        return content.trim();
      }
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("Persona adviser returned no content");
      }
      onContentDelta?.(content);
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
        streamed: false,
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
  backgroundModel?: string | undefined;
  retrievalLimit?: number | undefined;
  restoreTurns?: number | undefined;
  analyzeCompletedTurns?: boolean | undefined;
  usePreparedDrafts?: boolean | undefined;
}

interface PreparedMemory {
  normalizedQuery: string;
  selection: PersonaMemorySelection;
}

interface PreparedTurnPlan {
  normalizedQuery: string;
  sourceInput: string;
  plan: PersonaTurnPlan;
  continuityAnchors: string[];
  hasSelectedPreference: boolean;
  draftComplete: boolean;
  complete: boolean;
}

const relatedQuery = (prepared: string, current: string): boolean =>
  prepared.length >= 8 &&
  current.length >= 8 &&
  (prepared.startsWith(current) || current.startsWith(prepared));

export const unsafeCreativeDraft = (input: string, draft: string): boolean => {
  if (!creativePersonaRequest(input)) {
    return false;
  }
  const words = draft.trim().split(/\s+/).filter(Boolean).length;
  return words > 50 ||
    (jokePersonaRequest(input) &&
      !/^(?:okay[,.]?\s+)?(?:imagine\b|picture this\b)/i.test(draft.trim())) ||
    /\b(?:weird|fun|strange|random)\s+fact\s*:/i.test(draft) ||
    /\b(?:why did|what do you call|here(?:'s| is) (?:a )?(?:weird |fun |strange )?fact|i once(?: read| watched| saw| heard)?|i (?:watched|saw|heard)|my pet|when i was|did you know|scientists?|researchers?|first coined|in (?:18|19|20)\d{2}|species of|biologically|theoretically|scarecrow|outstanding in (?:his|her|their|the) field|knock knock|cross(?:ed|es|ing)? the road|books? on paranoia|snail[^.!?]{0,80}(?:fast|sports?) car|look at that (?:snail|s car) go|(?:a|an|two)\s+[^.!?]{0,32}\s+walk(?:s|ed)? into (?:a\s+)?(?:bar|library))\b/i.test(
      draft,
    );
};

const openLoopContinuityAnchors = (
  memories: readonly PersonaMemoryRecord[],
): string[] => Array.from(new Set(memories.flatMap((memory) => {
  if (memory.kind !== "open_loop") return [];
  const suffix = memory.canonicalKey.replace(
    /^user[.:-]+open(?:[-_.:]?loop)?[.:-]+/i,
    "",
  );
  const candidate = suffix === memory.canonicalKey
    ? memory.canonicalKey.split(/[.:-]+/).at(-1) ?? ""
    : suffix;
  return candidate
    .split(/[._:-]+/)
    .map((term) => term.trim().toLocaleLowerCase())
    .filter((term) => term.length >= 4 && !["user", "open", "loop"].includes(term));
})));

const preferenceCallbackAnchors = (
  memories: readonly PersonaMemoryRecord[],
): string[] => Array.from(new Set(memories.flatMap((memory) => {
  if (
    memory.kind !== "preference" ||
    memory.confidence < 0.8 ||
    (memory.relevance ?? 0) < 0.55
  ) {
    return [];
  }
  const anchor = memory.canonicalKey
    .split(/[._:-]+/)
    .map((term) => term.trim().toLocaleLowerCase())
    .filter((term) =>
      term.length >= 4 &&
      !["user", "preference", "preferences", "favorite", "likes"].includes(term))
    .at(-1);
  return anchor ? [anchor] : [];
})));

const memoryContinuityAnchors = (
  memories: readonly PersonaMemoryRecord[],
): string[] => Array.from(new Set([
  ...openLoopContinuityAnchors(memories),
  ...preferenceCallbackAnchors(memories),
]));

const preparedPlanUsesThought = (
  input: string,
  plan: PersonaTurnPlan,
  thought: PersonaThoughtRecord | undefined,
): boolean => {
  if (!thought || !selfContainedPersonaRequest(input)) return true;
  const ignored = new Set([
    "about", "after", "audrey", "background", "better", "could", "future",
    "human", "making", "offer", "playful", "reply", "reset", "should",
    "specific", "suggest", "suggesting", "their", "there", "thing", "thought",
    "using", "would",
  ]);
  const terms = normalizedMemoryText(`${thought.text} ${thought.topic}`)
    .split(" ")
    .filter((term) => term.length >= 5 && !ignored.has(term));
  const draft = normalizedMemoryText(plan.draftReply);
  return terms.some((term) => draft.includes(term));
};

export class PersonaMemoryRuntime {
  private prepared: PreparedMemory | undefined;
  private preparedPlan: PreparedTurnPlan | undefined;
  private planningQuery: string | undefined;
  private prepareGeneration = 0;
  private planGeneration = 0;
  private prepareController: AbortController | undefined;
  private planController: AbortController | undefined;
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

  public prepare(
    input: string,
    recentDialogue: readonly CelerisHistoryMessage[] = [],
  ): void {
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
        const highValueSelection: PersonaMemorySelection = {
          memories: selection.memories.filter(
            (memory) => memory.relevance === undefined || memory.relevance >= 0.55,
          ),
          ...(selection.thought ? { thought: selection.thought } : {}),
        };
        this.prepared = { normalizedQuery, selection: highValueSelection };
        this.preparePlan(query, normalizedQuery, recentDialogue, highValueSelection);
        this.options.logger.info("persona.memory.prefetch.ready", {
          durationMs: Math.round(performance.now() - started),
          memories: highValueSelection.memories.length,
          memoriesRejected: selection.memories.length - highValueSelection.memories.length,
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
    // Endpoint freezes the context. Work that has not produced even a partial
    // brief cannot help this response and should not keep spending tokens.
    this.planController?.abort();
    this.planController = undefined;
    this.planningQuery = undefined;
    this.planGeneration += 1;
    const memoryReady = Boolean(
      prepared && relatedQuery(prepared.normalizedQuery, normalizedQuery),
    );
    const planReady = Boolean(
      this.preparedPlan &&
      relatedQuery(this.preparedPlan.normalizedQuery, normalizedQuery),
    );
    if (!memoryReady && !planReady) {
      this.options.logger.info("persona.memory.snapshot", {
        ready: false,
        memories: 0,
        thoughtReady: false,
      });
      return undefined;
    }
    const selection = memoryReady ? prepared!.selection : { memories: [] };
    const frozenContinuityAnchors = planReady
      ? this.preparedPlan!.continuityAnchors
      : memoryContinuityAnchors(selection.memories);
    this.options.logger.info("persona.memory.snapshot", {
      ready: true,
      memories: selection.memories.length,
      thoughtReady: Boolean(selection.thought),
      turnPlanReady: planReady,
    });
    if (selection.thought) {
      void this.options.store
        .consumeThought(this.options.ownerKey, selection.thought.id)
        .catch((error) => this.options.logger.error("persona.thought.consume.failed", error));
    }
    return JSON.stringify({
      relevant_memories: selection.memories.map((memory) => ({
        kind: memory.kind,
        text: memory.text,
        source: memory.source,
        confidence: memory.confidence,
        recorded_at: memory.createdAt,
      })),
      ...(frozenContinuityAnchors.length > 0
        ? {
            required_continuity_anchors: frozenContinuityAnchors,
          }
        : {}),
      ...(selection.thought
        ? {
            optional_private_thought: {
              text: selection.thought.text,
              topic: selection.thought.topic,
              confidence: selection.thought.confidence,
            },
          }
        : {}),
      ...(this.preparedPlan && relatedQuery(
        this.preparedPlan.normalizedQuery,
        normalizedQuery,
      )
        ? {
            background_turn_brief: {
              based_on_partial_speech: this.preparedPlan.sourceInput,
              draft_reply: this.preparedPlan.plan.draftReply,
              complete: this.preparedPlan.complete,
              interpretation: this.preparedPlan.plan.interpretation,
              relevant_facts: this.preparedPlan.plan.relevantFacts,
              response_strategy: this.preparedPlan.plan.responseStrategy,
              response_ideas: this.preparedPlan.plan.responseIdeas,
              needs_adviser: this.preparedPlan.plan.needsAdviser,
              should_clarify: this.preparedPlan.plan.shouldClarify,
            },
          }
        : {}),
    });
  }

  public async contextForRecall(
    input: string,
    timeoutMs = 250,
  ): Promise<string | undefined> {
    const query = input.replace(/\s+/g, " ").trim();
    if (query.length < 3 || timeoutMs < 1) return undefined;
    const started = performance.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const lookup = this.options.embedder
        .embed([query])
        .then(([embedding]) =>
          this.options.store.retrieve(
            this.options.ownerKey,
            query,
            embedding,
            this.retrievalLimit,
          ),
        );
      const selection = await Promise.race([
        lookup,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new DOMException("Persona recall lookup timed out", "TimeoutError")),
            timeoutMs,
          );
        }),
      ]);
      const highValueSelection: PersonaMemorySelection = {
        memories: selection.memories.filter(
          (memory) => memory.relevance === undefined || memory.relevance >= 0.55,
        ),
        ...(selection.thought ? { thought: selection.thought } : {}),
      };
      this.options.logger.info("persona.memory.recall.ready", {
        durationMs: Math.round(performance.now() - started),
        memories: highValueSelection.memories.length,
        memoriesRejected:
          selection.memories.length - highValueSelection.memories.length,
        thoughtReady: Boolean(highValueSelection.thought),
      });
      if (
        highValueSelection.memories.length === 0 &&
        !highValueSelection.thought
      ) {
        return undefined;
      }
      if (highValueSelection.thought) {
        void this.options.store
          .consumeThought(this.options.ownerKey, highValueSelection.thought.id)
          .catch((error) =>
            this.options.logger.error("persona.thought.consume.failed", error));
      }
      const continuityAnchors = memoryContinuityAnchors(
        highValueSelection.memories,
      );
      return JSON.stringify({
        relevant_memories: highValueSelection.memories.map((memory) => ({
          kind: memory.kind,
          text: memory.text,
          source: memory.source,
          confidence: memory.confidence,
          recorded_at: memory.createdAt,
        })),
        ...(continuityAnchors.length > 0
          ? { required_continuity_anchors: continuityAnchors }
          : {}),
        ...(highValueSelection.thought
          ? {
              optional_private_thought: {
                text: highValueSelection.thought.text,
                topic: highValueSelection.thought.topic,
                confidence: highValueSelection.thought.confidence,
              },
            }
          : {}),
      });
    } catch (error) {
      this.options.logger.warn("persona.memory.recall.unavailable", {
        durationMs: Math.round(performance.now() - started),
        reason: error instanceof Error ? error.name : "unknown",
      });
      return undefined;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  public hasPreparedResponseIdea(input: string): boolean {
    const normalizedQuery = normalizedMemoryText(input);
    return Boolean(
      this.preparedPlan &&
      relatedQuery(this.preparedPlan.normalizedQuery, normalizedQuery) &&
      (Boolean(this.preparedPlan.plan.draftReply) ||
        this.preparedPlan.plan.responseIdeas.length > 0),
    );
  }

  public continuityAnchorFor(input: string): string | undefined {
    const normalizedQuery = normalizedMemoryText(input);
    const prepared = this.prepared;
    if (!prepared || !relatedQuery(prepared.normalizedQuery, normalizedQuery)) {
      return undefined;
    }
    const planned = this.preparedPlan;
    if (
      planned &&
      relatedQuery(planned.normalizedQuery, normalizedQuery) &&
      planned.continuityAnchors.length > 0
    ) {
      return planned.continuityAnchors[0];
    }
    return planned?.continuityAnchors[0] ??
      memoryContinuityAnchors(prepared.selection.memories)[0];
  }

  public continuityRepairPrefixFor(input: string): string | undefined {
    const normalizedQuery = normalizedMemoryText(input);
    const prepared = this.prepared;
    if (!prepared || !relatedQuery(prepared.normalizedQuery, normalizedQuery)) {
      return undefined;
    }
    const preference = prepared.selection.memories.find(
      (memory) =>
        memory.kind === "preference" &&
        preferenceCallbackAnchors([memory]).length > 0,
    );
    if (preference) {
      const detail = /\b(?:likes?|prefers?)\s+(.+?)[.!?]?$/i.exec(preference.text)?.[1]
        ?.replace(/\s+/g, " ")
        .trim();
      if (detail) return `That tracks; you have a soft spot for ${detail}.`;
    }
    const anchor = memoryContinuityAnchors(prepared.selection.memories).at(-1);
    return anchor ? `Right, the ${anchor}.` : undefined;
  }

  public preparedDraftFor(input: string): string | undefined {
    if (!this.options.usePreparedDrafts) return undefined;
    // Creative drafts are useful preparation, but they are too easy for a fast
    // planner to phrase as purported trivia or shared experience. Keep them as
    // context for the bounded candidate race instead of speaking them directly.
    if (creativePersonaRequest(input)) return undefined;
    const prepared = this.preparedPlan;
    if (!prepared?.draftComplete || !prepared.plan.draftReply) return undefined;
    if (prepared.plan.needsAdviser || prepared.plan.shouldClarify) return undefined;
    if (
      prepared.hasSelectedPreference &&
      !prepared.plan.memoryAnchorDecided &&
      prepared.continuityAnchors.length === 0
    ) {
      return undefined;
    }
    const candidate = [prepared.plan.draftReply, ...prepared.plan.responseIdeas].find(
      (draft) =>
        Boolean(draft) &&
        !unsafeCreativeDraft(input, draft) &&
        !(
          selfContainedPersonaRequest(input) &&
          draft.includes("?")
        ) &&
        (prepared.continuityAnchors.length === 0 ||
          prepared.continuityAnchors.some((anchor) =>
            normalizedMemoryText(draft).includes(anchor))),
    );
    if (!candidate) return undefined;
    const current = normalizedMemoryText(input);
    const source = prepared.normalizedQuery;
    if (!relatedQuery(source, current)) return undefined;
    const coverage = Math.min(source.length, current.length) /
      Math.max(source.length, current.length);
    if (coverage < 0.3) return undefined;
    const suffix = current.startsWith(source) ? current.slice(source.length).trim() : "";
    if (
      suffix &&
      /\b(?:actually|but|instead|no wait|wait|don t|do not|just|please|tell me|give me|can you|could you)\b/i.test(
        suffix,
      )
    ) {
      return undefined;
    }
    return candidate;
  }

  public runtimeContext(): string {
    const backgroundModel = this.options.backgroundModel;
    return JSON.stringify({
      durable_memory_enabled: true,
      background_context_planning_enabled: true,
      post_turn_memory_reflection_enabled: true,
      creative_adviser_available: true,
      ...(backgroundModel
        ? { background_model: backgroundModel }
        : {}),
      ...(backgroundModel?.toLocaleLowerCase().includes("deepseek")
        ? {
            likely_speech_aliases: {
              "deep sea flash": "DeepSeek Flash",
              "deep seek flash": "DeepSeek Flash",
            },
          }
        : {}),
      external_actions_available: false,
      visual_or_sensory_access: false,
    });
  }

  public speechReferenceHint(input: string): string | undefined {
    if (
      this.options.backgroundModel?.toLocaleLowerCase().includes("deepseek") &&
      /\bdeep\s+(?:sea|seek)(?:\s+flash)?\b/i.test(input)
    ) {
      return (
        "The ASR phrase 'deep sea flash' or 'deep seek flash' in this turn refers to the verified " +
        "background component DeepSeek Flash. Use that exact name. It reads the live partial transcript together " +
        "with recent dialogue and selected memory, then prepares a candidate reply or useful context while the " +
        "human is still speaking. It does not pre-read unknown future topics."
      );
    }
    return undefined;
  }

  public rememberTurn(user: string, assistant: string): void {
    this.prepareController?.abort();
    this.planController?.abort();
    this.prepareController = undefined;
    this.planController = undefined;
    this.prepared = undefined;
    this.preparedPlan = undefined;
    this.planningQuery = undefined;
    this.planGeneration += 1;
    if (this.options.analyzeCompletedTurns === false) return;
    this.backgroundTail = this.backgroundTail
      .then(() => this.processTurn(user, assistant))
      .catch((error) => this.options.logger.error("persona.memory.turn.failed", error));
  }

  public async askAdviser(
    request: string,
    recentDialogue: readonly CelerisHistoryMessage[],
    onPartial?: ((fragment: string) => void) | undefined,
    signal?: AbortSignal | undefined,
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
    return this.options.adviser.advise(
      request,
      { memories, recentDialogue },
      onPartial,
      signal,
    );
  }

  public async close(): Promise<void> {
    this.prepareController?.abort();
    this.planController?.abort();
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

  private preparePlan(
    input: string,
    normalizedQuery: string,
    recentDialogue: readonly CelerisHistoryMessage[],
    selection: PersonaMemorySelection,
  ): void {
    const words = normalizedQuery.split(" ").filter(Boolean).length;
    if (normalizedQuery.length < 14 || words < 3) return;
    if (
      this.planningQuery &&
      relatedQuery(this.planningQuery, normalizedQuery) &&
      normalizedQuery.length < this.planningQuery.length + 24
    ) {
      return;
    }
    if (
      this.preparedPlan &&
      relatedQuery(this.preparedPlan.normalizedQuery, normalizedQuery) &&
      normalizedQuery.length < this.preparedPlan.normalizedQuery.length + 24
    ) {
      return;
    }

    const generation = ++this.planGeneration;
    this.planController?.abort();
    const controller = new AbortController();
    this.planController = controller;
    this.planningQuery = normalizedQuery;
    const started = performance.now();
    const continuityAnchors = memoryContinuityAnchors(selection.memories);
    const hasSelectedPreference = selection.memories.some(
      (memory) => memory.kind === "preference",
    );
    let partialLogged = false;
    void this.options.adviser
      .planTurn(input, {
        memories: selection.memories,
        ...(selection.thought ? { thought: selection.thought } : {}),
        recentDialogue,
      }, (plan) => {
        if (generation !== this.planGeneration) return;
        if (!preparedPlanUsesThought(input, plan, selection.thought)) return;
        this.preparedPlan = {
          normalizedQuery,
          sourceInput: input,
          plan,
          continuityAnchors: Array.from(new Set([
            ...continuityAnchors,
            ...(continuityAnchors.length === 0 && plan.memoryAnchor
              ? [normalizedMemoryText(plan.memoryAnchor)]
              : []),
          ])),
          hasSelectedPreference,
          draftComplete: Boolean(plan.draftReply),
          complete: false,
        };
        if (!partialLogged) {
          partialLogged = true;
          this.options.logger.info("persona.turn_plan.partial_ready", {
            durationMs: Math.round(performance.now() - started),
          });
        }
      }, controller.signal)
      .then((plan) => {
        if (generation !== this.planGeneration) return;
        if (!preparedPlanUsesThought(input, plan, selection.thought)) {
          this.options.logger.warn("persona.turn_plan.thought_miss");
          return;
        }
        this.preparedPlan = {
          normalizedQuery,
          sourceInput: input,
          plan,
          continuityAnchors: Array.from(new Set([
            ...continuityAnchors,
            ...(continuityAnchors.length === 0 && plan.memoryAnchor
              ? [normalizedMemoryText(plan.memoryAnchor)]
              : []),
          ])),
          hasSelectedPreference,
          draftComplete: Boolean(plan.draftReply),
          complete: true,
        };
        this.options.logger.info("persona.turn_plan.ready", {
          durationMs: Math.round(performance.now() - started),
          responseIdeas: plan.responseIdeas.length,
          needsAdviser: plan.needsAdviser,
          shouldClarify: plan.shouldClarify,
        });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (generation !== this.planGeneration) return;
        this.options.logger.error("persona.turn_plan.failed", error);
      })
      .finally(() => {
        if (generation === this.planGeneration) {
          this.planningQuery = undefined;
          if (this.planController === controller) this.planController = undefined;
        }
      });
  }
}
