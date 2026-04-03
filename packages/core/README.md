# @agent-scheduler/core

AI API usage tracking and budget scheduling engine.

## Install

```bash
npm install @agent-scheduler/core
```

## Usage

```typescript
import { openDb, wrapAnthropic, schedule } from '@agent-scheduler/core';
import Anthropic from '@anthropic-ai/sdk';

// Open the local SQLite database
const db = openDb();

// Configure a budget
db.upsertBudget({
  id: 'default',
  name: 'default',
  limitUsd: 10,
  period: 'monthly',
  alertThreshold: 0.8,
  action: 'block',
});

// Wrap the Anthropic client for auto-tracking
const client = wrapAnthropic(new Anthropic(), { agentId: 'my-agent' });

// Or schedule tasks with budget awareness
await schedule(
  { id: 'task-1', priority: 'high', estimatedTokens: 2000, agentId: 'my-agent' },
  async () => {
    return client.messages.create({ /* ... */ });
  }
);

db.close();
```

## API

See the [full API reference](../../docs/api-reference.md).
