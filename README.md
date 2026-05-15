# @voightxyz/anthropic

> **Beta.** API may change before the 0.1.0 stable release.

Voight observability for the Anthropic SDK. Wrap your Anthropic client and capture every Messages call — prompts, tokens, costs, cache reads, tool use, latency, errors — surfaced live in the [Voight dashboard](https://voight.xyz).

Same author and same backend as [`@voightxyz/openai`](https://www.npmjs.com/package/@voightxyz/openai). Drop in whichever provider your app uses — the events land side-by-side in your Voight dashboard.

## Install

```bash
npm install @anthropic-ai/sdk @voightxyz/anthropic@beta
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
  model: 'claude-3-5-sonnet-latest',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
})
```

That's it — every call is captured automatically. Visit your [Voight dashboard](https://voight.xyz) to see them in real time.

## Status

Beta scaffold — the public `wrapAnthropic` entrypoint is a pass-through today. The Messages instrument lands in the next release. Track:

| Signal | Status |
|---|---|
| Public `wrapAnthropic` surface | ✅ scaffolded |
| `messages.create` non-streaming | 🟡 next release |
| `messages.create` streaming (event-based) | 🟡 next release |
| Token counts (input, output, cache_read, cache_creation) | 🟡 next release |
| Tool use capture | 🟡 next release |
| 3-level privacy redaction (minimal / standard / full) | 🟡 next release |
| Embeddings | ⏳ 0.2.0 |
| Vertex / Bedrock clients | ⏳ 0.2.0 |

See [CHANGELOG.md](./CHANGELOG.md).

## License

Apache 2.0
