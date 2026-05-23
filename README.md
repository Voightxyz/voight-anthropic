# @voightxyz/anthropic

Voight observability for the Anthropic SDK. Wrap your Anthropic client and capture every Messages call — prompts, tokens, cache reads, cache creations, tool use, costs, latency, errors — surfaced live in the [Voight dashboard](https://voight.xyz).

Same backend and dashboard as [`@voightxyz/openai`](https://www.npmjs.com/package/@voightxyz/openai). Drop in whichever provider your app uses; events from both land side-by-side under the same agent.

## Quick setup with the wizard

If your app already imports `@anthropic-ai/sdk`, the lowest-friction install is the wizard from the main SDK:

```bash
cd your-app
npx -y @voightxyz/sdk init
```

It detects `@anthropic-ai/sdk` (and `openai` if present) in your `package.json`, prompts for a privacy level + Voight key + agent name, and writes a ready-to-import `src/lib/voight.ts` with the wrapped client. 30 seconds, zero copy-paste. Full walkthrough at [docs.voight.xyz/ai-apps/wizard](https://docs.voight.xyz/ai-apps/wizard).

Continue below if you'd rather wire it manually.

## Install

```bash
npm install @anthropic-ai/sdk @voightxyz/anthropic
```

## Quick start

```ts
import Anthropic from '@anthropic-ai/sdk'
import { wrapAnthropic } from '@voightxyz/anthropic'

const client = wrapAnthropic(new Anthropic(), {
  voightApiKey: process.env.VOIGHT_KEY,
  agent: 'my-prod-agent',
})

const response = await client.messages.create({
  model: 'claude-haiku-4-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
})
```

That's it — every call is captured automatically. Visit your [Voight dashboard](https://voight.xyz) to see them in real time.

## Tracing & per-user attribution

For production apps where you want to group every LLM call inside one request into one trace, and attribute cost per end-user with one line of code, wrap each request boundary with `withTrace`:

```ts
import Anthropic from '@anthropic-ai/sdk'
import { wrapAnthropic, withTrace, log } from '@voightxyz/anthropic'

const anthropic = wrapAnthropic(new Anthropic(), {
  agent: 'production-chat-api',
  privacy: 'standard',
})

app.post('/api/chat', async (req, res) => {
  await withTrace(
    async () => {
      log('chat request received')
      const reply = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: req.body.prompt }],
      })
      res.json({ reply })
    },
    {
      routeTag: 'POST /api/chat',
      tags: { userId: req.user.id, plan: req.user.plan },
    },
  )
})
```

Every wrapped LLM call inside the `withTrace` block automatically inherits the `routeTag` and `tags`. The `tags.userId` field drives [per-user spend tracking](https://docs.voight.xyz/concepts/per-user-spend) — the dashboard's **Users sub-tab** populates with per-customer cost as soon as your first request lands.

The same `withTrace` exported here also works in [`@voightxyz/openai`](https://www.npmjs.com/package/@voightxyz/openai) — they share an async-context store, so an app calling both providers inside one request gets one trace, not two.

## What's captured

| Signal | Where it lands |
|---|---|
| Model id (with version suffix) | `model` |
| Prompt messages | `input.messages` |
| Response text (aggregated from `content[].text` blocks) | `metadata.responseText` |
| Token counts (input / output / total) | `metadata.tokens` |
| Cache reads (`cache_read_input_tokens`) | `metadata.tokens.cache_read` |
| Cache creations (`cache_creation_input_tokens`) | `metadata.tokens.cache_creation` |
| Tool use (full array) | `metadata.toolCalls` + `toolExecuted` |
| Streaming flag | `metadata.streaming` |
| Trace grouping (auto UUID or explicit) | `metadata.sessionId` |
| Stop reason | `metadata.finishReason` |
| Latency (ms) | `durationMs` |
| Errors (re-thrown to the caller) | `errorMessage` + `outcome: 'failed'` |

## Supported endpoints

- `client.messages.create` — Messages API (non-streaming + streaming, tool use, cache breakpoints)

The wrapper passes everything else through untouched. Bedrock and Vertex clients are on the [0.2.0 roadmap](./CHANGELOG.md).

## Options

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `voightApiKey` | string | `process.env.VOIGHT_KEY` | Your Voight key from the dashboard |
| `agent` | string | `process.env.VOIGHT_AGENT` → `HOSTNAME` → `'unknown-agent'` | Stable identifier surfaced in the dashboard |
| `apiBase` | string | `https://api.voight.xyz` | Override for self-hosted deployments |
| `privacy` | `'minimal' \| 'standard' \| 'full'` | `'standard'` | Capture aggressiveness |
| `sessionId` | string | auto UUID v4 | Trace grouping. Stable across calls of one wrapper instance |
| `enabled` | boolean | `true` | Kill switch — returns the original client untouched |
| `otel` | boolean | `false` | Emit captured calls as OpenTelemetry spans alongside the direct ingest. See [OpenTelemetry side-channel](#opentelemetry-side-channel) below. |

## OpenTelemetry side-channel

By default the wrapper POSTs each captured call directly to `api.voight.xyz`. Set `otel: true` to **additionally** emit each call as an OpenTelemetry span — useful when the host process already runs an OTel pipeline (Langfuse, Phoenix, Datadog, Sentry, or [`@voightxyz/vercel-ai`](https://www.npmjs.com/package/@voightxyz/vercel-ai)) and you want Voight events to appear there too.

```ts
const client = wrapAnthropic(new Anthropic(), { agent: 'my-app', otel: true })
```

Each span is named `voight.anthropic.messages` and carries the standard `gen_ai.*` semantic-convention attributes (`gen_ai.system` resolves to `'anthropic'`, plus `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read_input_tokens`, `gen_ai.response.finish_reasons`) plus the parallel Vercel-style `ai.*` namespace for cross-tool compatibility.

The direct ingest is unchanged — `otel: true` is purely additive. Default `otel: false` ships byte-identical behaviour to 0.1.7.

### Dedup marker

Every emitted span carries `voight.source: 'wrapper'`. If you also use [`@voightxyz/vercel-ai`](https://www.npmjs.com/package/@voightxyz/vercel-ai) ≥ 0.1.1 in the same process, that exporter recognises the marker and skips wrapper-emitted spans — no duplicate events in your dashboard.

### Optional peer dependency

`@opentelemetry/api` is now an **optional** peer dependency. If you never set `otel: true`, nothing changes — no extra install, no runtime cost. If you set `otel: true` but the package isn't installed, the wrapper logs a single warning and falls back to direct ingest only.

## Privacy

Three levels apply to prompts, response text, and tool-call arguments. The function name in `toolExecuted` always survives as a tag (not user content).

| Level | Prompts | Response text | Tool arguments | Tokens / timing / model |
| --- | --- | --- | --- | --- |
| `minimal` | dropped | dropped | dropped | kept |
| `standard` (default) | scrubbed | scrubbed | scrubbed | kept |
| `full` | verbatim | verbatim | verbatim | kept |

Standard scrubs 12 patterns: PEM private keys, JWTs, Anthropic / OpenAI / Stripe live / GitHub / AWS / Slack / Voight API keys, emails, E.164 phones, and Luhn-validated credit cards.

See [CHANGELOG.md](./CHANGELOG.md) for release notes.

## License

Apache 2.0
