// Instrument for `client.messages.create`.
//
// Stub — real implementation arrives in the next release. The plan,
// mirroring the proven @voightxyz/openai pattern:
//
//   - Non-streaming: read `response.usage` (input_tokens,
//     output_tokens, cache_creation_input_tokens,
//     cache_read_input_tokens). Map cache_read_input_tokens into
//     `metadata.tokens.cache_read` so the backend Anthropic Path-A
//     pricing applies the 0.10x cache_read multiplier and the 1.25x
//     cache_creation multiplier correctly.
//
//   - Streaming: Anthropic emits a typed event sequence
//     (`message_start`, `content_block_start`, `content_block_delta`,
//     `content_block_stop`, `message_delta`, `message_stop`) rather
//     than the OpenAI-style chunked completion. The aggregator must
//     reassemble text deltas, tool_use blocks (input_json_delta
//     fragments), and the final usage that arrives on `message_delta`.
//
//   - Tool use: capture `content[*]` blocks of type `tool_use` and
//     mirror the first tool's `name` into the top-level
//     `toolExecuted` field (audit-log compat — same shape we ship
//     for OpenAI tool calls).
//
//   - Privacy fan-out: identical contract to @voightxyz/openai
//     (`minimal` → tags only, `standard` → scrubbed content,
//     `full` → verbatim).
//
// Keeping the file in the tree from day one ensures the module
// graph is stable and any consumer importing types via the public
// surface won't see a moving target.
//
// See ../wrap.ts for how this will be wired in via Proxy when the
// real implementation lands.
