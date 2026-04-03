# agent-scheduler

[![npm version](https://img.shields.io/npm/v/agent-scheduler)](https://npmjs.com/package/agent-scheduler)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Stop overspending on AI APIs.** Monitor usage, set budgets, and schedule tasks across Claude, OpenAI, and Gemini — all in one open-source tool.

---

## The Problem

Running AI agents is expensive. You have:
- Multiple AI providers with different pricing models
- No single view of total spend across providers
- No way to enforce budgets or pause low-priority tasks when limits are near
- Complex per-provider APIs that lag real-time

## The Solution

```bash
npx agent-scheduler init
```

One command sets up real-time usage tracking across all your AI providers.

## Quick Start

```bash
# Install
npm install agent-scheduler

# Initialize (creates local SQLite DB)
npx agent-scheduler init

# Set a daily budget of $10
npx agent-scheduler budget set --limit 10 --period daily --action alert

# Check current status
npx agent-scheduler status
```

## SDK Wrapper

```typescript
import { schedule } from 'agent-scheduler';
import Anthropic from '@anthropic-ai/sdk';

// Drop-in wrapper — intercepts every response and tracks usage
const client = schedule(new Anthropic(), {
  budgetUsd: 10, // $10/day limit
  onUsage: (record) => console.log(`${record.model}: $${record.costUsd.toFixed(4)}`),
});

// Use exactly like a normal Anthropic client
const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

## Dashboard

```bash
npx agent-scheduler dashboard
# Opens http://localhost:4242
```

- Real-time usage charts by provider and model
- Budget progress bars with alerting
- Per-agent cost breakdown (Paperclip integration)
- Export usage to CSV

## Paperclip Integration

Add to your Paperclip plugin to gate agent heartbeats against your budget:

```json
{
  "hooks": [{
    "event": "agent:heartbeat:before",
    "command": "agent-scheduler check-budget --agent-id $PAPERCLIP_AGENT_ID"
  }]
}
```

## Features

| Feature | Status |
|---------|--------|
| Anthropic Claude tracking | ✅ |
| OpenAI tracking | 🔜 |
| Gemini tracking | 🔜 |
| Budget enforcement (alert/block/queue) | ✅ |
| Priority-based scheduling queue | ✅ |
| Web dashboard | ✅ |
| Paperclip plugin | ✅ |
| Team/multi-user support | 🔜 |

## Supported Models & Pricing

| Model | Input (per 1M) | Output (per 1M) |
|-------|---------------|-----------------|
| claude-opus-4 | $15.00 | $75.00 |
| claude-sonnet-4-6 | $3.00 | $15.00 |
| claude-haiku-4-5 | $0.80 | $4.00 |
| gpt-4o | $5.00 | $15.00 |
| gpt-4o-mini | $0.15 | $0.60 |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). PRs welcome!

## License

MIT © suho-software
