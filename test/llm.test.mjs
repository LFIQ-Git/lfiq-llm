import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ROUTES,
  anthropicSettings,
  chat,
  chatJson,
  llmConfigured,
  onRun,
  parseRoute,
  resolveRoute,
  setWorkersAi,
  taskEnvName,
} from "../dist/llm.js";

const realFetch = globalThis.fetch;
let runs = [];
let anthropicCalls = [];

function aiBinding(reply) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      return typeof reply === "function" ? reply(model, input) : reply;
    },
  };
}

function anthropicReply(body, status = 200) {
  globalThis.fetch = async (url, init) => {
    anthropicCalls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

beforeEach(() => {
  runs = [];
  anthropicCalls = [];
  onRun((r) => runs.push(r));
  setWorkersAi(null);
  delete process.env.ANTHROPIC_API_KEY;
  for (const k of Object.keys(process.env)) if (k.startsWith("AI_ROUTE_")) delete process.env[k];
  globalThis.fetch = realFetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

const ARGS = { task: "pursue.blurb", tier: "fast", system: "One sentence.", messages: [{ role: "user", content: "Why?" }] };

test("routes never name OCP and match the seeded lfiq rows", () => {
  const all = Object.values(ROUTES).flat();
  assert.ok(all.every((l) => l.provider === "workers-ai" || l.provider === "anthropic"));
  assert.deepEqual(ROUTES.fast.map((l) => l.model), ["@cf/openai/gpt-oss-120b", "claude-haiku-4-5"]);
  assert.deepEqual(ROUTES.standard.map((l) => l.model), ["claude-sonnet-5-5"]);
});

test("source has no OCP code path", async () => {
  const src = await readFile(new URL("../llm.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /OCP_|ocp\.lfiq|"ocp"/i);
});

test("an OCP leg in an override is refused", async () => {
  assert.throws(() => parseRoute("ocp:claude-sonnet-5-5"), /not allowed on the LFIQ router/);
  process.env.AI_ROUTE_PURSUE_BRIEF = "ocp:claude-sonnet-5-5";
  await assert.rejects(resolveRoute("pursue.brief", "standard"), /not allowed/);
});

test("per-task env override replaces the tier route", async () => {
  assert.equal(taskEnvName("pursue.competitor_study"), "AI_ROUTE_PURSUE_COMPETITOR_STUDY");
  process.env.AI_ROUTE_PURSUE_BRIEF = "workers-ai:@cf/openai/gpt-oss-120b, anthropic:claude-sonnet-5-5";
  assert.deepEqual(await resolveRoute("pursue.brief", "standard"), [
    { provider: "workers-ai", model: "@cf/openai/gpt-oss-120b" },
    { provider: "anthropic", model: "claude-sonnet-5-5" },
  ]);
});

test("fast tier answers from Workers AI and logs a free run", async () => {
  const ai = aiBinding({ choices: [{ message: { content: " Owner is near a refinance window. " } }], usage: { prompt_tokens: 40, completion_tokens: 12 } });
  setWorkersAi(ai);
  const r = await chat(ARGS);
  assert.equal(r.text, "Owner is near a refinance window.");
  assert.equal(r.provider, "workers-ai");
  assert.equal(r.fellBack, false);
  assert.equal(ai.calls[0].model, "@cf/openai/gpt-oss-120b");
  assert.equal(ai.calls[0].input.messages[0].role, "system");
  assert.ok(ai.calls[0].input.max_tokens > 1024, "reasoning headroom added");
  assert.equal(runs.length, 1);
  assert.deepEqual(
    { router: runs[0].router, app: runs[0].app, task: runs[0].task, ok: runs[0].ok, input: runs[0].input_tokens },
    { router: "lfiq", app: "pursue", task: "pursue.blurb", ok: true, input: 40 },
  );
});

test("fast tier falls back to Anthropic when Workers AI fails, and records both", async () => {
  setWorkersAi(aiBinding(() => { throw new Error("capacity"); }));
  process.env.ANTHROPIC_API_KEY = "sk-test-0000000000";
  anthropicReply({ content: [{ type: "text", text: "Fallback sentence." }], usage: { input_tokens: 9, output_tokens: 4 } });
  const r = await chat(ARGS);
  assert.equal(r.provider, "anthropic");
  assert.equal(r.model, "claude-haiku-4-5");
  assert.equal(r.fellBack, true);
  assert.deepEqual(runs.map((x) => [x.provider, x.ok]), [["workers-ai", false], ["anthropic", true]]);
  assert.equal(anthropicCalls[0].headers["x-api-key"], "sk-test-0000000000");
});

test("a leg with no credentials is skipped, and a total failure names every leg", async () => {
  await assert.rejects(chat(ARGS), /workers-ai: not configured \| anthropic: not configured/);
  assert.equal(llmConfigured("pursue.blurb", "fast"), false);
  setWorkersAi(aiBinding({ response: "x" }));
  assert.equal(llmConfigured("pursue.blurb", "fast"), true);
  assert.equal(llmConfigured("pursue.brief", "standard"), false);
});

test("Anthropic errors are redacted in logs", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-0000000000";
  anthropicReply({ error: { message: "bad key sk-ant-abcdefghijkl" } }, 401);
  await assert.rejects(chat({ ...ARGS, tier: "standard" }), /anthropic 401/);
  assert.match(runs[0].error, /\[redacted\]/);
  assert.doesNotMatch(runs[0].error, /abcdefghijkl/);
});

test("task keys must be app.task", async () => {
  await assert.rejects(chat({ ...ARGS, task: "blurb" }), /app\.task/);
});

test("chatJson uses structured output on Anthropic, never a forced tool", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-0000000000";
  anthropicReply({ content: [{ type: "text", text: '{"summary":"ok","people":[{"name":"A"}]}' }], stop_reason: "end_turn", usage: {} });
  const schema = { type: "object", properties: { summary: { type: "string" }, people: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } } }, required: ["summary"] };
  const r = await chatJson({ ...ARGS, task: "pursue.competitor_study", tier: "standard", schema, schemaName: "record_study" });
  assert.deepEqual(r.data, { summary: "ok", people: [{ name: "A" }] });
  const body = anthropicCalls[0].body;
  assert.equal(body.tool_choice, undefined);
  assert.equal(body.tools, undefined);
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.output_config.format.schema.additionalProperties, false);
  assert.equal(body.output_config.format.schema.properties.people.items.additionalProperties, false);
  assert.deepEqual(body.thinking, { type: "between_tools" });
});

test("Sonnet 5.5 runs without thinking and without sampling settings; Haiku 4.5 keeps temperature", () => {
  assert.deepEqual(anthropicSettings("claude-sonnet-5-5", 900, 0.2), { max_tokens: 900, thinking: { type: "between_tools" } });
  assert.deepEqual(anthropicSettings("claude-haiku-4-5", 100, 0.2), { max_tokens: 100, temperature: 0.2 });
  const opus = anthropicSettings("claude-opus-5-5", 900);
  assert.ok(opus.max_tokens > 900);
  assert.deepEqual(opus.output_config, { effort: "low" });
  assert.equal(opus.thinking, undefined);
});

test("an answer cut off at max_tokens fails instead of returning partial text", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-0000000000";
  anthropicReply({ content: [{ type: "text", text: "## Ranking\nAt 96/100 the" }], stop_reason: "max_tokens", usage: { output_tokens: 900 } });
  await assert.rejects(chat({ ...ARGS, task: "pursue.brief", tier: "standard", maxTokens: 900 }), /cut off at max_tokens/);
  assert.equal(runs[0].ok, false);
});

test("a refusal fails over instead of returning empty text", async () => {
  process.env.AI_ROUTE_PURSUE_BRIEF = "anthropic:claude-sonnet-5-5,anthropic:claude-haiku-4-5";
  process.env.ANTHROPIC_API_KEY = "sk-test-0000000000";
  let n = 0;
  globalThis.fetch = async (url, init) => {
    anthropicCalls.push({ body: JSON.parse(init.body) });
    const body = n++ === 0
      ? { content: [], stop_reason: "refusal", usage: {} }
      : { content: [{ type: "text", text: "Answer." }], stop_reason: "end_turn", usage: {} };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const r = await chat({ ...ARGS, task: "pursue.brief", tier: "standard" });
  assert.equal(r.model, "claude-haiku-4-5");
  assert.equal(anthropicCalls[1].body.thinking, undefined, "router drops between_tools when it moves to another model");
});

test("chatJson on Workers AI sends json_schema and fails over on unparseable output", async () => {
  process.env.AI_ROUTE_PURSUE_COMPETITOR_STUDY = "workers-ai:@cf/openai/gpt-oss-120b,anthropic:claude-sonnet-5-5";
  const ai = aiBinding({ choices: [{ message: { content: "not json" } }] });
  setWorkersAi(ai);
  process.env.ANTHROPIC_API_KEY = "sk-test-0000000000";
  anthropicReply({ content: [{ type: "text", text: '{"summary":"paid"}' }], stop_reason: "end_turn", usage: {} });
  const schema = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] };
  const r = await chatJson({ ...ARGS, task: "pursue.competitor_study", tier: "standard", schema, schemaName: "record_study" });
  assert.equal(ai.calls[0].input.response_format.type, "json_schema");
  assert.equal(r.provider, "anthropic");
  assert.equal(r.fellBack, true);
});

test("a slow leg times out and the next leg answers", async () => {
  setWorkersAi(aiBinding(() => new Promise(() => {})));
  process.env.ANTHROPIC_API_KEY = "sk-test-0000000000";
  anthropicReply({ content: [{ type: "text", text: "late but here" }], usage: {} });
  const r = await chat({ ...ARGS, timeoutMs: 50 });
  assert.equal(r.provider, "anthropic");
  assert.match(runs[0].error, /timed out/);
});

test("with the control plane set, the lfiq table picks the route and runs are posted", async () => {
  delete globalThis.__lfiqLlmControl;
  process.env.AI_CONTROL_URL = "https://backend.test/";
  process.env.AI_CONTROL_SECRET = "sched";
  process.env.ANTHROPIC_API_KEY = "sk-test-0000000000";
  const posted = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://backend.test/api/v1/ai/config")) {
      assert.equal(init.headers["x-scheduler-secret"], "sched");
      return new Response(JSON.stringify({ routes: [
        { tier: "standard", task: null, primary: { provider: "anthropic", model: "claude-sonnet-5-5" }, fallback: null },
        { tier: "standard", task: "pursue.brief", primary: { provider: "workers_ai", model: "@cf/openai/gpt-oss-120b" }, fallback: { provider: "anthropic", model: "claude-sonnet-5-5" } },
        { tier: "fast", task: null, primary: { provider: "ocp", model: "claude-haiku-4-5" }, fallback: null },
      ] }), { status: 200 });
    }
    if (u === "https://backend.test/api/v1/ai/runs") { posted.push(...JSON.parse(init.body).runs); return new Response("{}", { status: 201 }); }
    anthropicCalls.push({ body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ content: [{ type: "text", text: "paid" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } }), { status: 200 });
  };
  setWorkersAi(aiBinding({ choices: [{ message: { content: "free" } }] }));
  const r = await chat({ ...ARGS, task: "pursue.brief", tier: "standard" });
  assert.equal(r.text, "free");
  assert.equal(r.provider, "workers-ai");
  assert.deepEqual(await resolveRoute("pursue.study", "fast"), ROUTES.fast, "an OCP row in the table is ignored on the LFIQ router");
  assert.equal(posted.length, 1);
  assert.equal(posted[0].task, "pursue.brief");
  delete process.env.AI_CONTROL_URL;
  delete process.env.AI_CONTROL_SECRET;
  delete globalThis.__lfiqLlmControl;
});
