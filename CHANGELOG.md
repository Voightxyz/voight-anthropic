# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] — 2026-05-16

First stable release. Consolidates beta.1 and beta.2.

### Capabilities

- `wrapAnthropic(client, options)` — two-layer Proxy (`client → messages → create`). Everything outside `messages.create` passes through untouched.
- Non-streaming Messages capture: text extracted from `content[].text` blocks, tool calls flattened from `content[].tool_use` blocks (input JSON-stringified to the same `arguments: string` shape `@voightxyz/openai` produces — dashboards render both providers identically).
- Streaming Messages capture: state machine over the typed event sequence (`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop`). Per-index aggregator concatenates text deltas (`text_delta.text`) and tool-use deltas (`input_json_delta.partial_json`). Initial usage from `message_start` carries `input_tokens` + cache fields; final `output_tokens` lands on `message_delta`.
- Path-A token breakdown: `cache_read_input_tokens` → `metadata.tokens.cache_read`, `cache_creation_input_tokens` → `metadata.tokens.cache_creation`. Both emitted only when strictly positive. `input` + `output` + `total` always present. The backend Anthropic pricing engine applies the 0.10× cache_read and 1.25× cache_creation multipliers automatically.
- First tool call's name mirrored into top-level `toolExecuted` so the audit-log DETAIL column renders meaningfully for LLM events (same shape used for hook events).
- `sessionId` emission: each wrapper instance resolves a UUID v4 once (or accepts an explicit override) and stamps it on `metadata.sessionId` for every event. Dashboards group events sharing a sessionId into a single trace timeline.
- Three-level privacy redaction (`minimal` / `standard` / `full`) over prompts, response text, and tool arguments via a 12-pattern catalogue. Function-call names always survive as tags.
- Fire-and-forget HTTP ingest to `https://api.voight.xyz/v1/events`. Never throws, never blocks the caller.
- API key + agent identity resolution: `voightApiKey` option → `VOIGHT_KEY` env → `null`. `agent` option → `VOIGHT_AGENT` env → `HOSTNAME` env → `'unknown-agent'`.
- Non-fatal failure modes: `enabled: false` and missing API key both return the original client untouched.

### Tests

- 65 unit tests across privacy, identity, ingest, messages, and wrap surfaces. All green.
- End-to-end smoke verified against real Anthropic + real Voight backend: text, streaming text, tool use (both transports), `cache_read` on cached prompts.

## [0.1.0-beta.2] — 2026-05-16

### Added

- `sessionId` is now stamped on every emitted event under `metadata.sessionId`. The wrapper auto-generates a UUID v4 once per `wrapAnthropic()` call and reuses it for the life of the wrapped client. An explicit `options.sessionId` overrides the auto value so callers can scope a trace per-user / per-conversation / per-request. The Voight dashboard groups events with the same `sessionId` into a single trace timeline.

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
