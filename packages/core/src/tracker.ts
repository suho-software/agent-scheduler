import { calcCostUsdWithCache, UsageRecord } from './types.js';
import type { AgentSchedulerDb } from './db.js';

export type AnthropicUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export class BudgetExceededError extends Error {
  constructor(public readonly budgetName: string, public readonly limitUsd: number) {
    super(`Budget '${budgetName}' exceeded ($${limitUsd} limit). Request blocked.`);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Wraps an Anthropic SDK client to intercept usage from every response
 * and record it locally. Works by wrapping the `messages.create` method.
 */
export function wrapAnthropic<T extends { messages: { create: (...args: any[]) => any } }>(
  client: T,
  onUsage: (record: Omit<UsageRecord, 'id' | 'timestamp'>) => void,
  onBeforeRequest?: () => void,
): T {
  const originalCreate = client.messages.create.bind(client.messages);

  client.messages.create = async (...args: any[]) => {
    onBeforeRequest?.();
    const response = await originalCreate(...args);
    const model: string = response.model ?? args[0]?.model ?? 'unknown';
    const usage: AnthropicUsage = response.usage ?? { input_tokens: 0, output_tokens: 0 };
    const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
    const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;

    onUsage({
      provider: 'anthropic',
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: calcCostUsdWithCache(model, usage.input_tokens, usage.output_tokens, cacheReadTokens, cacheWriteTokens),
    });

    return response;
  };

  return client;
}

/**
 * Convenience wrapper with optional DB-backed budget enforcement.
 *
 * When `db` is provided, checks all budgets before each request:
 * - Prints a warning to stderr at alertThreshold (default 80%)
 * - Throws `BudgetExceededError` when action='block' and 100% is exceeded
 */
export function schedule<T extends { messages: { create: (...args: any[]) => any } }>(
  client: T,
  opts: {
    budgetUsd?: number;
    db?: AgentSchedulerDb;
    onUsage?: (r: Omit<UsageRecord, 'id' | 'timestamp'>) => void;
  },
): T {
  const onBeforeRequest = opts.db
    ? () => checkBudgets(opts.db!)
    : undefined;

  return wrapAnthropic(
    client,
    (record) => {
      opts.onUsage?.(record);
      opts.db?.insertUsage(record);
    },
    onBeforeRequest,
  );
}

function checkBudgets(db: AgentSchedulerDb): void {
  const budgets = db.listBudgets();
  for (const budget of budgets) {
    const status = db.getBudgetStatus(budget);
    if (status.usagePercent >= 1.0 && budget.action === 'block') {
      throw new BudgetExceededError(budget.name, budget.limitUsd);
    }
    if (status.usagePercent >= budget.alertThreshold) {
      const pct = (status.usagePercent * 100).toFixed(1);
      process.stderr.write(
        `\x1b[33m[agent-scheduler] WARNING: Budget '${budget.name}' at ${pct}% ($${status.spentUsd.toFixed(4)} / $${budget.limitUsd})\x1b[0m\n`,
      );
    }
  }
}
