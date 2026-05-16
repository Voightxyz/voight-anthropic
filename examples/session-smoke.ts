/**
 * Verify that sessionId lands on metadata for every event from a
 * single wrapper instance. Two calls from the same wrapped client
 * → both events should share one sessionId.
 *
 *   ANTHROPIC_API_KEY=... VOIGHT_KEY=... npx tsx examples/session-smoke.ts
 */

import Anthropic from '@anthropic-ai/sdk'
import { wrapAnthropic } from '../src/index.js'

async function main() {
  const client = wrapAnthropic(new Anthropic(), {
    agent: 'voight-anthropic-smoke-test',
    privacy: 'full',
  })

  await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Reply with: session-1' }],
  })
  await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Reply with: session-2' }],
  })
  await new Promise((r) => setTimeout(r, 1000))
  console.log('[smoke] 2 anthropic events fired — same sessionId expected on both')
}

main().catch((err) => {
  console.error('[smoke] failed:', err)
  process.exit(1)
})
