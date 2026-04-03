# API Reference

## `@agent-scheduler/core`

### `openDb(path?)`

Opens (or creates) the SQLite database at the given path.

```typescript
import { openDb } from '@agent-scheduler/core';

const db = openDb('~/.agent-scheduler.db');
// ... use db
db.close();
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | `string` | `.agent-scheduler.db` | Path to the SQLite file |

Returns: `AgentSchedulerDb`

---

### `AgentSchedulerDb`

#### `insertUsage(record)`

Records a single API call.

```typescript
db.insertUsage({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  inputTokens: 150,
  outputTokens: 300,
  costUsd: 0.000525,
  agentId: 'my-agent',  // optional
  taskId: 'SUH-45',     // optional
});
```

#### `upsertBudget(budget)`

Creates or updates a budget.

```typescript
db.upsertBudget({
  id: 'monthly-default',
  name: 'default',
  limitUsd: 10,
  period: 'monthly',
  alertThreshold: 0.8,
  action: 'block',
});
```

#### `getBudgetStatus(budget)`

Returns current spend vs. the budget for the current period.

```typescript
const status = db.getBudgetStatus(budget);
// status.spentUsd, status.remainingUsd, status.usagePercent (0–1)
```

#### `listBudgets()`

Returns all configured budgets.

#### `listUsage(opts?)`

Returns usage records.

```typescript
db.listUsage({ limit: 50, provider: 'anthropic', agentId: 'my-agent' });
```

---

### `wrapAnthropic(client, opts?)`

Wraps an Anthropic SDK client so all calls are tracked automatically.

```typescript
import { wrapAnthropic } from '@agent-scheduler/core';

const tracked = wrapAnthropic(client, { agentId: 'my-agent' });
```

---

### `schedule(task, fn, opts?)`

Schedules a task subject to budget constraints.

```typescript
import { schedule } from '@agent-scheduler/core';

await schedule(
  { id: 'task-1', priority: 'high', estimatedTokens: 2000, agentId: 'my-agent' },
  async () => { /* expensive API call */ }
);
```

Throws `BudgetExceededError` if a blocking budget is exceeded.

---

### Types

```typescript
type Provider = 'anthropic' | 'openai' | 'gemini';

interface UsageRecord {
  id: string;
  timestamp: Date;
  provider: Provider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  agentId?: string;
  taskId?: string;
}

interface Budget {
  id: string;
  name: string;
  limitUsd: number;
  period: 'daily' | 'weekly' | 'monthly';
  alertThreshold: number; // 0–1
  action: 'alert' | 'block' | 'queue';
}

interface BudgetStatus {
  budget: Budget;
  spentUsd: number;
  remainingUsd: number;
  usagePercent: number; // 0–1
  periodStart: Date;
  periodEnd: Date;
}
```

---

## `@agent-scheduler/cli` (CLI reference)

### `agent-scheduler init`

Interactive setup wizard.

### `agent-scheduler status`

Show usage summary and budget progress bars.

### `agent-scheduler check-budget [--agent-id <id>]`

Exit 0 if all blocking budgets are within limit; exit 1 if any are exceeded.

### `agent-scheduler budget set <name> <limitUsd>`

Options: `--period daily|weekly|monthly`, `--action alert|block|queue`, `--threshold 0-1`

### `agent-scheduler budget list`

List all configured budgets.

### `agent-scheduler usage list`

Options: `--provider anthropic|openai|gemini`, `--limit <n>`
