/**
 * @lfiq/lfiq-llm — the LFIQ router for Pursue, Watch, Parcel, Home and Website.
 *
 * Two providers, in route order:
 *   - "workers-ai" — Cloudflare Workers AI through the calling Worker's own `AI`
 *                    binding (register it with setWorkersAi). Free up to the
 *                    account's daily Neuron allowance.
 *   - "anthropic"  — the Anthropic Messages API (ANTHROPIC_API_KEY). Paid.
 *
 * LFIQ apps never use OCP (decided 2026-10-07). This package has no OCP code
 * path and reads no OCP setting.
 *
 * Callers name a task key ("pursue.brief") and a tier, never a model id. The
 * tier picks a route from ROUTES; AI_ROUTE_<TASK> overrides it for one task,
 * e.g. AI_ROUTE_PURSUE_BRIEF="workers-ai:@cf/openai/gpt-oss-120b,anthropic:claude-sonnet-5-5".
 * The models live in the ai.routes table on the AI Console Models page; reading
 * that table here comes with phase 2 of the AI Model Usage Plan. Until then the
 * built-in ROUTES below match the table's seed.
 *
 * No runtime dependencies: fetch for Anthropic, the binding for Workers AI.
 */

export type Provider = "workers-ai" | "anthropic";
export type Tier = "fast" | "standard";

export interface RouteLeg {
  provider: Provider;
  model: string;
}

/** Built-in routes per tier. Mirrors the lfiq rows of ai.routes (migration 227). */
export const ROUTES: Record<Tier, RouteLeg[]> = {
  fast: [
    { provider: "workers-ai", model: "@cf/openai/gpt-oss-120b" },
    { provider: "anthropic", model: "claude-haiku-4-5" },
  ],
  standard: [{ provider: "anthropic", model: "claude-sonnet-5-5" }],
};

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatArgs {
  /** Task key, app.task in lowercase: "pursue.blurb". Logged and used for overrides. */
  task: string;
  tier: Tier;
  system: string;
  messages: ChatMessage[];
  /** Tokens for the answer itself. Reasoning models get extra headroom on top. */
  maxTokens?: number;
  temperature?: number;
  /** Abort a leg after this many milliseconds and move to the next. Default 60 s. */
  timeoutMs?: number;
}

export interface JsonArgs extends ChatArgs {
  /** JSON Schema the answer must match. Sent as structured output (output_config.format on Anthropic, response_format on Workers AI). */
  schema: Record<string, unknown>;
  /** Name for the schema, e.g. "record_study". */
  schemaName: string;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
}

export interface ChatResult {
  text: string;
  provider: Provider;
  model: string;
  usage: Usage;
  /** True when an earlier leg failed and a later one answered. */
  fellBack: boolean;
  latencyMs: number;
}

export interface JsonResult<T = unknown> extends Omit<ChatResult, "text"> {
  data: T;
}

/** One finished call, success or failure. Matches the columns of ai.runs. */
export interface RunRecord {
  router: "lfiq";
  app: string;
  task: string;
  tier: Tier;
  provider: Provider;
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  latency_ms: number;
  fell_back: boolean;
  ok: boolean;
  error?: string;
}

/* ------------------------------------------------------------ registration */

/** Minimal shape of a Workers AI binding (`env.AI`). */
export interface WorkersAiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

// Kept on globalThis, not in module variables: bundlers can load this module
// more than once per isolate, and a registration made through one copy must be
// visible to the other.
const G = globalThis as unknown as Record<string, unknown>;
const AI_KEY = "__lfiqLlmWorkersAi";
const RUN_KEY = "__lfiqLlmOnRun";

/** Register the calling Worker's `AI` binding. Call once per request or isolate. */
export function setWorkersAi(binding: WorkersAiBinding | null): void {
  G[AI_KEY] = binding;
}

/** Receive every finished call (for ai.runs or metrics). Errors in the hook are swallowed. */
export function onRun(hook: ((rec: RunRecord) => void | Promise<void>) | null): void {
  G[RUN_KEY] = hook;
}

/* ------------------------------------------------------------------ routes */

function env(name: string): string | undefined {
  const v = typeof process !== "undefined" ? process.env?.[name] : undefined;
  return v && v.trim() ? v.trim() : undefined;
}

export function taskEnvName(task: string): string {
  return `AI_ROUTE_${task.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/** Parse "provider:model,provider:model". Unknown providers (including ocp) are refused. */
export function parseRoute(spec: string): RouteLeg[] {
  return spec.split(",").map((part) => {
    const s = part.trim();
    const i = s.indexOf(":");
    const provider = s.slice(0, i) as Provider;
    const model = s.slice(i + 1).trim();
    if (i < 1 || !model) throw new Error(`bad route leg "${s}": use provider:model`);
    if (provider !== "workers-ai" && provider !== "anthropic") {
      throw new Error(`route provider "${provider}" is not allowed on the LFIQ router (workers-ai or anthropic only)`);
    }
    return { provider, model };
  });
}

/** The legs a task will try, in order. */
export function resolveRoute(task: string, tier: Tier): RouteLeg[] {
  const override = env(taskEnvName(task));
  if (override) return parseRoute(override);
  const legs = ROUTES[tier];
  if (!legs) throw new Error(`unknown tier "${tier}"`);
  return legs;
}

/** True when this task has at least one usable leg right now. */
export function llmConfigured(task = "", tier: Tier = "fast"): boolean {
  try {
    return resolveRoute(task || "any.task", tier).some((leg) => legAvailable(leg));
  } catch {
    return false;
  }
}

function legAvailable(leg: RouteLeg): boolean {
  if (leg.provider === "workers-ai") return Boolean(G[AI_KEY]);
  return Boolean(env("ANTHROPIC_API_KEY"));
}

/* --------------------------------------------------------------- providers */

interface LegOutput {
  text: string;
  usage: Usage;
}

const TASK_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

// gpt-oss spends tokens on reasoning before it answers, and max_tokens covers both.
const REASONING_HEADROOM = 1024;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type WorkersAiResponse = {
  response?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

async function callWorkersAi(
  model: string,
  args: ChatArgs,
  json?: { schema: Record<string, unknown>; name: string },
): Promise<LegOutput> {
  const ai = G[AI_KEY] as WorkersAiBinding | undefined;
  if (!ai) throw new Error("workers-ai binding not registered (call setWorkersAi(env.AI))");
  const raw = (await ai.run(model, {
    messages: [{ role: "system", content: args.system }, ...args.messages],
    max_tokens: (args.maxTokens ?? 1024) + REASONING_HEADROOM,
    ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
    ...(json
      ? { response_format: { type: "json_schema", json_schema: { name: json.name, strict: true, schema: json.schema } } }
      : {}),
  })) as WorkersAiResponse;
  const content = raw?.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : typeof raw?.response === "string" ? raw.response : "";
  if (!text.trim()) throw new Error(`workers-ai returned no text (${model})`);
  return { text: text.trim(), usage: { input_tokens: raw?.usage?.prompt_tokens, output_tokens: raw?.usage?.completion_tokens } };
}

type AnthropicResponse = {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
};

// Headroom for models whose thinking cannot be turned off; thinking tokens count against max_tokens.
const THINKING_HEADROOM = 4096;

/**
 * Per-model request settings. Thinking tokens count against max_tokens, so a
 * model that thinks by default needs thinking off or extra room, or the answer
 * is cut short.
 *   - claude-haiku-4-*: no thinking by default; sampling settings allowed.
 *   - claude-sonnet-5-5: thinks by default; `between_tools` turns it off.
 *   - other current models (Opus 5.5 etc.): thinking always on; low effort plus headroom.
 */
export function anthropicSettings(model: string, maxTokens: number, temperature?: number): Record<string, unknown> {
  if (model.startsWith("claude-haiku-4")) {
    return { max_tokens: maxTokens, ...(temperature !== undefined ? { temperature } : {}) };
  }
  if (model === "claude-sonnet-5-5") {
    return { max_tokens: maxTokens, thinking: { type: "between_tools" } };
  }
  return { max_tokens: maxTokens + THINKING_HEADROOM, output_config: { effort: "low" } };
}

/** Structured outputs need additionalProperties: false on every object. */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    out[k] = k === "properties" && v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, strictSchema(pv)]))
      : strictSchema(v);
  }
  const t = out.type;
  if ((t === "object" || (Array.isArray(t) && t.includes("object"))) && !("additionalProperties" in out)) {
    out.additionalProperties = false;
  }
  return out;
}

async function callAnthropic(
  model: string,
  args: ChatArgs,
  json?: { schema: Record<string, unknown> },
): Promise<LegOutput> {
  const key = env("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const settings = anthropicSettings(model, args.maxTokens ?? 1024, args.temperature);
  const outputConfig = {
    ...((settings.output_config as Record<string, unknown> | undefined) ?? {}),
    ...(json ? { format: { type: "json_schema", schema: strictSchema(json.schema) } } : {}),
  };
  delete settings.output_config;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      system: args.system,
      messages: args.messages,
      ...settings,
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as AnthropicResponse;
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${body.error?.message ?? "request failed"}`);
  if (body.stop_reason === "refusal") throw new Error(`anthropic declined the request (${model})`);
  if (body.stop_reason === "max_tokens") throw new Error(`anthropic answer cut off at max_tokens (${model})`);
  const usage = { input_tokens: body.usage?.input_tokens, output_tokens: body.usage?.output_tokens };
  const text = (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
  if (!text) throw new Error(`anthropic returned no text (${model})`);
  return { text, usage };
}

/* -------------------------------------------------------------------- core */

const SECRET_PATTERNS: RegExp[] = [/sk-[A-Za-z0-9_-]{8,}/g, /Bearer\s+[A-Za-z0-9._-]{8,}/gi];

function redact(e: unknown): string {
  let s = e instanceof Error ? e.message : String(e);
  for (const p of SECRET_PATTERNS) s = s.replace(p, "[redacted]");
  return s.slice(0, 300);
}

function appName(task: string): string {
  return task.split(".")[0];
}

async function record(rec: RunRecord): Promise<void> {
  console.log(JSON.stringify({ event: "llm.call", ...rec }));
  const hook = G[RUN_KEY] as ((r: RunRecord) => void | Promise<void>) | undefined;
  if (!hook) return;
  try {
    await hook(rec);
  } catch {
    /* a logging failure never fails the call */
  }
}

async function runLegs<T extends LegOutput>(
  args: ChatArgs,
  call: (leg: RouteLeg) => Promise<T>,
): Promise<{ out: T; leg: RouteLeg; fellBack: boolean; latencyMs: number }> {
  if (!TASK_PATTERN.test(args.task)) throw new Error(`task key "${args.task}" must be app.task in lowercase`);
  const legs = resolveRoute(args.task, args.tier);
  const errors: string[] = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const fellBack = i > 0;
    const base = { router: "lfiq" as const, app: appName(args.task), task: args.task, tier: args.tier, provider: leg.provider, model: leg.model };
    if (!legAvailable(leg)) {
      errors.push(`${leg.provider}: not configured`);
      continue;
    }
    const t0 = Date.now();
    try {
      const out = await withTimeout(call(leg), args.timeoutMs ?? 60_000, `${leg.provider} ${leg.model}`);
      const latencyMs = Date.now() - t0;
      await record({ ...base, input_tokens: out.usage.input_tokens, output_tokens: out.usage.output_tokens, latency_ms: latencyMs, fell_back: fellBack, ok: true });
      return { out, leg, fellBack, latencyMs };
    } catch (e) {
      const msg = redact(e);
      errors.push(`${leg.provider}: ${msg}`);
      await record({ ...base, latency_ms: Date.now() - t0, fell_back: fellBack, ok: false, error: msg });
    }
  }
  throw new Error(`all LFIQ router legs failed for ${args.task}: ${errors.join(" | ")}`);
}

/** Free-text answer. */
export async function chat(args: ChatArgs): Promise<ChatResult> {
  const { out, leg, fellBack, latencyMs } = await runLegs(args, (l) =>
    l.provider === "workers-ai" ? callWorkersAi(l.model, args) : callAnthropic(l.model, args),
  );
  return { text: out.text, provider: leg.provider, model: leg.model, usage: out.usage, fellBack, latencyMs };
}

/** Structured answer matching a JSON Schema. A leg whose output does not parse fails over to the next. */
export async function chatJson<T = unknown>(args: JsonArgs): Promise<JsonResult<T>> {
  const spec = { schema: args.schema, name: args.schemaName };
  const { out, leg, fellBack, latencyMs } = await runLegs(args, async (l) => {
    const r = l.provider === "anthropic" ? await callAnthropic(l.model, args, spec) : await callWorkersAi(l.model, args, spec);
    let data: T;
    try {
      data = JSON.parse(r.text) as T;
    } catch {
      throw new Error(`${l.provider} returned invalid JSON (${l.model})`);
    }
    return { ...r, data };
  });
  return { data: (out as LegOutput & { data: T }).data, provider: leg.provider, model: leg.model, usage: out.usage, fellBack, latencyMs };
}
