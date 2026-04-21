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
 *
 * Supports both standard (non-streaming) and streaming (`stream: true`) calls:
 * - Non-streaming: usage is read from `response.usage` on the resolved Message.
 * - Streaming: usage is accumulated from `message_start` (input tokens + cache)
 *   and `message_delta` (output tokens) events, then recorded after the stream ends.
 */
export function wrapAnthropic<T extends { messages: { create: (...args: any[]) => any } }>(
  client: T,
  onUsage: (record: Omit<UsageRecord, 'id' | 'timestamp'>) => void,
  onBeforeRequest?: () => void,
): T {
  const originalCreate = client.messages.create.bind(client.messages);

  client.messages.create = async (...args: any[]) => {
    onBeforeRequest?.();
    const isStreaming = args[0]?.stream === true;
    const response = await originalCreate(...args);

    if (isStreaming) {
      return instrumentStream(response, args[0]?.model ?? 'unknown', onUsage);
    }

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
 * Wraps an Anthropic stream (AsyncIterable of MessageStreamEvents) to
 * transparently pass all events through while accumulating usage from
 * `message_start` and `message_delta` events. Fires `onUsage` once the
 * stream is exhausted.
 *
 * This is an async generator so it satisfies the `AsyncIterable` contract
 * that the Anthropic SDK Stream class also satisfies.
 */
export async function* instrumentStream(
  stream: AsyncIterable<any>,
  fallbackModel: string,
  onUsage: (record: Omit<UsageRecord, 'id' | 'timestamp'>) => void,
): AsyncGenerator<any> {
  let model = fallbackModel;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  for await (const event of stream) {
    yield event;

    if (event.type === 'message_start' && event.message) {
      model = event.message.model ?? model;
      const u: AnthropicUsage = event.message.usage ?? {};
      inputTokens = u.input_tokens ?? 0;
      cacheReadTokens = u.cache_read_input_tokens ?? 0;
      cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
    } else if (event.type === 'message_delta' && event.usage) {
      outputTokens = event.usage.output_tokens ?? 0;
    }
  }

  onUsage({
    provider: 'anthropic',
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd: calcCostUsdWithCache(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
  });
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

/**
 * Wraps an OpenAI SDK client (`openai.chat.completions.create`) to intercept
 * usage from every response and record it locally.
 *
 * Supports both standard and streaming calls:
 * - Non-streaming: usage is read from `response.usage` (prompt_tokens / completion_tokens).
 * - Streaming: automatically injects `stream_options: { include_usage: true }` so the
 *   final chunk carries usage, then accumulates it via `instrumentOpenAIStream`.
 */
export function wrapOpenAI<T extends { chat: { completions: { create: (...args: any[]) => any } } }>(
  client: T,
  onUsage: (record: Omit<UsageRecord, 'id' | 'timestamp'>) => void,
  onBeforeRequest?: () => void,
): T {
  const originalCreate = client.chat.completions.create.bind(client.chat.completions);

  client.chat.completions.create = async (...args: any[]) => {
    onBeforeRequest?.();
    const isStreaming = args[0]?.stream === true;

    if (isStreaming) {
      // Inject stream_options.include_usage so the API emits usage in the last chunk.
      const params = { ...args[0], stream_options: { ...args[0]?.stream_options, include_usage: true } };
      const stream = await originalCreate(params, ...args.slice(1));
      return instrumentOpenAIStream(stream, args[0]?.model ?? 'unknown', onUsage);
    }

    const response = await originalCreate(...args);
    const model: string = response.model ?? args[0]?.model ?? 'unknown';
    const usage = response.usage ?? {};
    const inputTokens: number = usage.prompt_tokens ?? 0;
    const outputTokens: number = usage.completion_tokens ?? 0;
    // OpenAI exposes cache hits in prompt_tokens_details.cached_tokens (no cache-write cost).
    const cacheReadTokens: number = usage.prompt_tokens_details?.cached_tokens ?? 0;

    onUsage({
      provider: 'openai',
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
      costUsd: calcCostUsdWithCache(model, inputTokens, outputTokens, cacheReadTokens, 0),
    });

    return response;
  };

  return client;
}

/**
 * Wraps an OpenAI streaming response (AsyncIterable of ChatCompletionChunk) to
 * transparently pass all chunks through while collecting usage from the final
 * chunk (which carries usage when `stream_options.include_usage` is set).
 *
 * Fires `onUsage` exactly once after the stream is exhausted.
 */
export async function* instrumentOpenAIStream(
  stream: AsyncIterable<any>,
  fallbackModel: string,
  onUsage: (record: Omit<UsageRecord, 'id' | 'timestamp'>) => void,
): AsyncGenerator<any> {
  let model = fallbackModel;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;

  for await (const chunk of stream) {
    yield chunk;

    if (chunk.model) model = chunk.model;

    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? 0;
      outputTokens = chunk.usage.completion_tokens ?? 0;
      cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
    }
  }

  onUsage({
    provider: 'openai',
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    costUsd: calcCostUsdWithCache(model, inputTokens, outputTokens, cacheReadTokens, 0),
  });
}

// ─── Convenience wrappers ─────────────────────────────────────────────────────

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
