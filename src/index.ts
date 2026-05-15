// Public surface of @voightxyz/anthropic.
//
// The package's contract is intentionally tiny: one function that
// takes an Anthropic client and returns a wrapped client with the
// same shape. Everything else (ingest transport, privacy redaction,
// identity resolution) is an implementation detail and not part of
// the public API.

export { wrapAnthropic } from './wrap.js'
export type { WrapOptions, PrivacyLevel } from './types.js'
