# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0-beta.1] — Unreleased

### Added

- Initial scaffold (mirrors `@voightxyz/openai`).
- Public `wrapAnthropic(client, options)` entrypoint, pass-through pending the messages instrument.
- Ported `privacy.ts` (12 PII patterns + Luhn-validated card scrub), `identity.ts` (API key + agent resolution with VOIGHT_KEY / VOIGHT_AGENT fallback), and `ingest.ts` (fire-and-forget POST to `https://api.voight.xyz/v1/events`).
