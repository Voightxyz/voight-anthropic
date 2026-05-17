// Public surface of @voightxyz/anthropic.
//
// The package's contract is intentionally tiny: wrap an Anthropic
// client, optionally open a trace around a request handler, and emit
// context log lines from inside that handler. Everything else
// (ingest transport, privacy redaction, identity resolution, async
// context plumbing) is an implementation detail and not part of the
// public API.

export { wrapAnthropic } from './wrap.js'
export { log } from './log.js'
export { withTrace } from './context.js'
export type { WrapOptions, PrivacyLevel } from './types.js'
export type { LogLevel, LogOptions } from './log.js'
