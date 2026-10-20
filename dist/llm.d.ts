/**
 * @lfiq/lfiq-llm — the LFIQ router for Pursue, Watch, Parcel, Home and Website.
 *
 * Two providers, in route order:
 *   - "workers-ai" — Cloudflare Workers AI through the calling Worker's own `AI`
 *                    binding (register it with setWorkersAi). Free up to the
 *                    account's daily Neuron allowance.
 *   - "anthropic"  — the Anthropic Messages API, through the Cloudflare AI Gateway when
 *                    AI_GATEWAY_TOKEN is set, else directly with ANTHROPIC_API_KEY. Paid.
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
export declare const ROUTES: Record<Tier, RouteLeg[]>;
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
/** Minimal shape of a Workers AI binding (`env.AI`). */
export interface WorkersAiBinding {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
}
/** Register the calling Worker's `AI` binding. Call once per request or isolate. */
export declare function setWorkersAi(binding: WorkersAiBinding | null): void;
/** Receive every finished call (for ai.runs or metrics). Errors in the hook are swallowed. */
export declare function onRun(hook: ((rec: RunRecord) => void | Promise<void>) | null): void;
export declare function taskEnvName(task: string): string;
/** Parse "provider:model,provider:model". Unknown providers (including ocp) are refused. */
export declare function parseRoute(spec: string): RouteLeg[];
/** Refresh the lfiq route table when older than 60 s. Never throws. */
export declare function refreshRoutes(force?: boolean): Promise<void>;
/** The legs a task will try, in order: AI_ROUTE_<TASK>, the ai.routes table, then ROUTES. */
export declare function resolveRoute(task: string, tier: Tier): Promise<RouteLeg[]>;
/** Send queued runs to ai.runs. Awaited at the end of every call (2 s cap). Never throws. */
export declare function flushRuns(): Promise<void>;
/** True when this task has at least one usable leg right now. */
export declare function llmConfigured(task?: string, tier?: Tier): boolean;
/** The Left Field Cloudflare AI Gateway's Anthropic endpoint (gateway "default"). */
export declare const DEFAULT_AI_GATEWAY_URL = "https://gateway.ai.cloudflare.com/v1/c16c7246ee0a89e6deafe19a74480c6a/default/anthropic";
/** True when the Anthropic leg can run: through the AI Gateway, or directly with a key. */
export declare function anthropicConfigured(): boolean;
/**
 * Per-model request settings. Thinking tokens count against max_tokens, so a
 * model that thinks by default needs thinking off or extra room, or the answer
 * is cut short.
 *   - claude-haiku-4-*: no thinking by default; sampling settings allowed.
 *   - claude-sonnet-5-5: thinks by default; `between_tools` turns it off.
 *   - other current models (Opus 5.5 etc.): thinking always on; low effort plus headroom.
 */
export declare function anthropicSettings(model: string, maxTokens: number, temperature?: number): Record<string, unknown>;
/** Structured outputs need additionalProperties: false on every object. */
export declare function strictSchema(schema: unknown): unknown;
/** Free-text answer. */
export declare function chat(args: ChatArgs): Promise<ChatResult>;
/** Structured answer matching a JSON Schema. A leg whose output does not parse fails over to the next. */
export declare function chatJson<T = unknown>(args: JsonArgs): Promise<JsonResult<T>>;
//# sourceMappingURL=llm.d.ts.map