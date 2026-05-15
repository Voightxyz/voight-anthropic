// Public entrypoint of @voightxyz/anthropic.
//
// Today this is a scaffold pass-through: it accepts the same options
// shape as `@voightxyz/openai`'s `wrapOpenAI` and returns the client
// unchanged. The messages instrument lands next — see
// `instruments/messages.ts` for the planned shape.
//
// Keeping the public surface stable from day one means the next
// release can light up real capture without breaking any caller
// who installed the scaffold against the published types.

import type { WrapOptions } from './types.js'

export function wrapAnthropic<T extends object>(
  client: T,
  _options: WrapOptions = {},
): T {
  // Scaffold: no proxy, no ingest. The next release wires in
  // `instrumentMessages` from `instruments/messages.ts` via a
  // three-layer Proxy (client → messages → create), matching the
  // pattern proven in @voightxyz/openai.
  return client
}
