# Quick Start

## 1. Install and initialize

```bash
npm install -g @agent-scheduler/cli
agent-scheduler init
```

## 2. Set a budget

```bash
# Block heartbeats when $10/month is exceeded
agent-scheduler budget set default 10 --period monthly --action block

# Or just alert (no blocking)
agent-scheduler budget set default 10 --period monthly --action alert
```

## 3. Track API usage from code

```typescript
import { wrapAnthropic } from '@agent-scheduler/core';
import Anthropic from '@anthropic-ai/sdk';

const client = wrapAnthropic(new Anthropic(), { agentId: 'my-agent' });

// Use exactly like the normal Anthropic client — usage is tracked automatically
const message = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
});
```

## 4. Check status

```bash
agent-scheduler status
```

Example output:

```
  agent-scheduler status

  Today       $0.0024
  This month  $1.8432
  Records     142

  Budgets:

  default (monthly)
    [████████░░░░░░░░░░░░] 18.4% of $10
```

## 5. Use with Paperclip

Install the Paperclip plugin to automatically gate heartbeats based on budget:

```bash
# From your Paperclip workspace
paperclipai skill install @agent-scheduler/paperclip-plugin
```

The plugin registers an `agent:heartbeat:before` hook that calls `agent-scheduler check-budget` before each agent heartbeat. If any blocking budget is exceeded, the heartbeat is cancelled.
