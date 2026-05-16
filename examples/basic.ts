/**
 * End-to-end smoke test for `wrapAnthropic`.
 *
 * Run with real credentials in the environment:
 *
 *   ANTHROPIC_API_KEY=sk-ant-...    real Anthropic key, used for new Anthropic()
 *   VOIGHT_KEY=vk_...               Voight API key, used by the wrapper
 *
 * Then:
 *   npx tsx examples/basic.ts
 *
 * Expected: three calls land in the Voight dashboard under the
 * agent label printed at startup. The first is a plain text reply,
 * the second exercises a tool call, the third runs in streaming mode
 * so the per-index aggregator concatenates the tool's
 * input_json_delta fragments into a single argument string.
 */

import Anthropic from '@anthropic-ai/sdk'
import { wrapAnthropic } from '../src/index.js'

const TOOLS = [
  {
    name: 'get_weather',
    description: 'Return the current weather for a city.',
    input_schema: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City name, e.g. "Tokyo" or "Madrid"',
        },
      },
      required: ['location'],
    },
  },
]

async function main() {
  const agent = 'voight-anthropic-smoke-test'
  console.log(`[smoke] agent = ${agent}`)

  const client = wrapAnthropic(new Anthropic(), {
    agent,
    privacy: 'full',
  })

  // ── 1. Non-streaming text ────────────────────────────────────
  console.log('[smoke] non-streaming text…')
  const r1 = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 64,
    messages: [
      { role: 'user', content: 'Reply with exactly: pong' },
    ],
  })
  const firstText = r1.content.find((b: { type: string }) => b.type === 'text')
  console.log(
    `[smoke] non-streaming response: ${(firstText as { text?: string } | undefined)?.text ?? '(no text block)'}`,
  )

  // ── 2. Non-streaming tool_use ─────────────────────────────────
  console.log('[smoke] non-streaming tool_use…')
  const r2 = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 256,
    tools: TOOLS,
    messages: [
      {
        role: 'user',
        content:
          "What's the weather in Tokyo right now? Use the available tool.",
      },
    ],
  })
  const toolUse = r2.content.find((b: { type: string }) => b.type === 'tool_use') as
    | { id: string; name: string; input: unknown }
    | undefined
  if (toolUse) {
    console.log(
      `[smoke] non-streaming tool: ${toolUse.name}(${JSON.stringify(toolUse.input)})`,
    )
  } else {
    console.log('[smoke] non-streaming: model returned no tool call (text only)')
  }

  // ── 3. Streaming text + tool_use ──────────────────────────────
  console.log('[smoke] streaming with tool_use…')
  const stream = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 256,
    stream: true,
    tools: TOOLS,
    messages: [
      {
        role: 'user',
        content: 'Search the weather for Madrid using the tool.',
      },
    ],
  })

  const toolNames = new Set<string>()
  let text = ''
  for await (const event of stream as AsyncIterable<{
    type: string
    delta?: { type?: string; text?: string; partial_json?: string }
    content_block?: { type?: string; name?: string }
  }>) {
    if (
      event.type === 'content_block_delta' &&
      event.delta?.type === 'text_delta' &&
      typeof event.delta.text === 'string'
    ) {
      text += event.delta.text
    }
    if (
      event.type === 'content_block_start' &&
      event.content_block?.type === 'tool_use' &&
      event.content_block.name
    ) {
      toolNames.add(event.content_block.name)
    }
  }
  console.log(
    `[smoke] streaming tools seen: ${[...toolNames].join(', ') || '(none)'}`,
  )
  if (text) console.log(`[smoke] streaming text: ${text}`)

  // Give the fire-and-forget ingest a beat to flush.
  await new Promise((r) => setTimeout(r, 1000))
  console.log('[smoke] done. Check the Voight dashboard:')
  console.log('         3 events under voight-anthropic-smoke-test agent,')
  console.log('         with metadata.source = "anthropic-sdk" and tokens captured.')
}

main().catch((err) => {
  console.error('[smoke] failed:', err)
  process.exit(1)
})
