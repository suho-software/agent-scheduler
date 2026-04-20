# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

<!-- Add entries here as work is merged. Move to a versioned section on release. -->

---

## [0.1.0] — 2026-04-04

MVP release. Core tracking, CLI, Paperclip plugin, and Anthropic SDK wrapper.

### Added

- `packages/core`: SQLite-backed usage tracking engine
  - Per-provider token and cost recording
  - Daily/weekly/monthly budget periods
  - Budget threshold actions: `alert`, `pause`, `block`
- `packages/cli`: `agent-scheduler` command-line interface
  - `init` — initialize local SQLite database
  - `budget set` — configure spend limits per period
  - `status` — display current spend vs. budget at a glance
- `packages/paperclip-plugin`: Paperclip hook + skill integration
  - Auto-tracks Claude API calls made by Paperclip agents
  - Exposes budget status as a skill for agent decision-making
- Anthropic SDK wrapper (`schedule()`) — drop-in replacement for `new Anthropic()`
  - Intercepts every response and records token usage
  - Enforces budget limits before each request
- MIT license

### Infrastructure

- Turbo monorepo setup with shared TypeScript config
- GitHub Actions: `ci.yml` (build + test on PR), `release.yml` (publish to npm on tag)

---

## [0.1.1] — TBD

_Planned: dogfooding fixes from initial self-hosted usage._

<!-- Entries will be added here as issues are resolved. -->

---

[Unreleased]: https://github.com/suho-software/agent-scheduler/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/suho-software/agent-scheduler/releases/tag/v0.1.0
[0.1.1]: https://github.com/suho-software/agent-scheduler/compare/v0.1.0...v0.1.1
