# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0-beta.1] — 2026-05-16

### Added

- `wrapAnthropic(client, options)` — Proxy wrapper of two layers (`client → messages → create`). Captures every `client.messages.create` call into a Voight event without changing the caller's interface. Anything outside the `messages.create` path passes through untouched via `Reflect.get`.
- Non-streaming Messages capture: extracts text from `content[].text` blocks, tool calls from `content[].tool_use` blocks (with `input` JSON-stringified into the same `arguments: string` shape `@voightxyz/openai` produces).
- Streaming Messages capture: state machine over the event sequence (`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop`). Per-index aggregator concatenates text deltas and `input_json_delta` fragments. First tool call's name mirrored into top-level `toolExecuted` for audit-log compat.
- Path-A token breakdown: `usage.cache_read_input_tokens` → `metadata.tokens.cache_read`, `usage.cache_creation_input_tokens` → `metadata.tokens.cache_creation`. Both emitted only when strictly positive so the payload stays tight on non-cache events. `input` + `output` + `total` always present; backend Anthropic pricing engine already applies the 0.10× cache_read and 1.25× cache_creation multipliers.
- Three-level privacy redaction: `minimal` (drop prompts / response text / tool args, keep `toolExecuted` name), `standard` (scrub PII via the 12-pattern catalogue), `full` (verbatim). Errors always captured.
- API key + agent identity resolution: `voightApiKey` option → `VOIGHT_KEY` env → null. `agent` option → `VOIGHT_AGENT` env → `HOSTNAME` env → `'unknown-agent'`.
- Fire-and-forget HTTP ingest to `https://api.voight.xyz/v1/events`. Never throws, never blocks the caller. Errors route to an optional `onError` hook.
- `enabled: false` and no-API-key paths are non-fatal — both return the original client untouched so misconfiguration cannot crash the host app.

### Tests

- 62 unit tests covering non-streaming (text, tool_use, mixed, cache fields, finish reason, privacy levels, errors), streaming (pass-through, text aggregation, tool_use delta aggregation, cache from message_start), and `wrapAnthropic` proxy behaviour. All green.
