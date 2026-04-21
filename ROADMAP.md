# Roadmap

This document outlines the planned direction for agent-scheduler. Priorities shift based on community feedback and real-world usage — [dogfood issues](https://github.com/suho-software/agent-scheduler/issues?q=label%3Adogfood) get weighted heavily.

---

## Phase 1 — Open Source Core *(current)*

**Goal:** A reliable, zero-config budget monitor for individual developers and small teams.

### Completed ✅

- SQLite-backed usage tracking (no external dependencies)
- CLI: `init`, `budget set`, `status`, `budget list`, `budget delete`
- Anthropic SDK wrapper (`schedule()`, `wrapAnthropic()`) — streaming support included
- OpenAI SDK wrapper (`wrapOpenAI()`) — auto-injects `stream_options.include_usage`
- Gemini SDK wrapper (`wrapGeminiModel()`) — wraps `generateContent` + `generateContentStream`
- Dual CJS+ESM build via tsup (Firebase Functions / Next.js compatible)
- Human-readable spend report: `agent-scheduler report --period daily|weekly|monthly`
- `budget reset <id>` — non-destructive spend counter reset via `reset_at` timestamp (schema v4)
- Paperclip plugin (hook + skill)
- GitHub Actions CI/release pipeline

### In progress / near-term

- [ ] Fix issues surfaced by dogfooding (tracked under [`dogfood` label](https://github.com/suho-software/agent-scheduler/issues?q=label%3Adogfood))
- [x] Shell completions (bash, zsh, fish) — `agent-scheduler completion bash|zsh|fish`

### Community contribution opportunities

- Additional AI provider wrappers (Mistral, Cohere, Bedrock, etc.)
- Improved error messages and UX
- Additional test coverage

---

## Phase 2 — Ecosystem Integration *(6–12 months)*

**Goal:** Become the standard observability layer for AI agent infrastructure.

- [ ] Paperclip official plugin registry listing
- [ ] VS Code multi-root workspace integration
  - Budget status in the status bar
  - Per-workspace spend breakdown
- [ ] Web dashboard (optional local server: `agent-scheduler dashboard`)
- [ ] SaaS tier: team-shared budget, multi-user dashboards, alerts via email/Slack
- [ ] Webhook support for budget events (pause, alert, block)

---

## Phase 3 — Platform *(12 months+)*

**Goal:** Multi-provider AI cost management platform for teams and enterprises.

- [ ] Multi-provider unified cost view
- [ ] Per-agent and per-project cost attribution
- [ ] Enterprise plan: SSO, audit logs, role-based access
- [ ] API for programmatic budget management (for CI pipelines, agent orchestrators)
- [ ] Cost forecasting based on usage trends

---

## How to influence the roadmap

1. **Use it and report friction** — open a [dogfood issue](https://github.com/suho-software/agent-scheduler/issues/new?template=dogfood.md)
2. **Vote with thumbs-up** on existing issues you care about
3. **Open a feature request** if your use case isn't covered
4. **Contribute** — PRs for items marked "community contribution opportunities" are warmly welcomed

---

*Last updated: 2026-04-21*
