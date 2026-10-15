# @lfiq/lfiq-llm

The LFIQ router for Pursue, Watch, Parcel, Home and Website. It tries Cloudflare Workers AI first and then the Anthropic API. It never uses OCP; that rule was decided on 2026-10-07, and the source has no OCP code path.

Callers name a task key and a tier, never a model id.

```ts
import { chat, chatJson, setWorkersAi, onRun } from "@lfiq/lfiq-llm";

setWorkersAi(env.AI); // once per request or isolate, from the Worker entry
const r = await chat({ task: "pursue.blurb", tier: "fast", system, messages, maxTokens: 120 });
// r.text, r.provider, r.model, r.usage, r.fellBack, r.latencyMs
```

## Tiers

| Tier | Route |
|---|---|
| `fast` | Workers AI `@cf/openai/gpt-oss-120b`, then Anthropic `claude-haiku-4-5` |
| `standard` | Anthropic `claude-sonnet-5-5` |

These match the `lfiq` rows of `ai.routes` (brick.command migration 227), which you edit on the AI Console Models page. Reading that table at runtime comes with phase 2 of the AI Model Usage Plan.

A free model replaces a paid one for a task only after it wins or ties at least 8 of 10 blind comparisons with no factual errors.

## Overrides

`AI_ROUTE_<TASK>` replaces the route for one task. The task key is uppercased, with dots turned into underscores:

```
AI_ROUTE_PURSUE_BRIEF="workers-ai:@cf/openai/gpt-oss-120b,anthropic:claude-sonnet-5-5"
```

Only `workers-ai` and `anthropic` are accepted as providers.

## Structured output

`chatJson({ ..., schema, schemaName })` returns `data` that matches the schema:

- **Anthropic:** structured output (`output_config.format`). The router adds `additionalProperties: false` to every object in the schema.
- **Workers AI:** the schema is sent as `response_format: json_schema`.

If a leg returns JSON that doesn't parse, the router moves on to the next leg.

## Model settings

Thinking tokens count against `max_tokens`, so the router sets each model up so the answer isn't cut short:

| Model | Settings |
|---|---|
| `claude-haiku-4-5` | No thinking. Temperature is passed through. |
| `claude-sonnet-5-5` | `thinking: between_tools`, which turns thinking off. Sampling settings aren't sent (Sonnet 5.5 rejects them). |
| Other current models | Low effort, plus 4,096 tokens of headroom |

An answer that stops at `max_tokens`, or a refusal, counts as a failed leg. The next leg runs instead of the call returning partial text.

## Logging

Every attempt logs one `llm.call` JSON line, with fields matching the `ai.runs` columns. Pass `onRun(hook)` to receive each record as well. Error text is redacted.

## Environment

| Name | Use |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic leg |
| `AI_ROUTE_<TASK>` | Per-task route override |

The Workers AI leg uses the Worker's `AI` binding (`[ai] binding = "AI"` in wrangler), registered with `setWorkersAi`.

## Develop

```bash
npm install
npm test          # builds dist/ and runs node:test
npm run check:dist
```

`dist/` is committed. Consumers install this package by commit SHA (`github:LFIQ-Git/lfiq-llm#<sha>`) and don't build it.
