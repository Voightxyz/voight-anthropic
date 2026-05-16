# @voightxyz/anthropic

Voight observability for the Anthropic SDK. Wrap your Anthropic client and capture every Messages call — prompts, tokens, cache reads, cache creations, tool use, costs, latency, errors — surfaced live in the [Voight dashboard](https://voight.xyz).

Same backend and dashboard as [`@voightxyz/openai`](https://www.npmjs.com/package/@voightxyz/openai). Drop in whichever provider your app uses; events from both land side-by-side under the same agent.

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
