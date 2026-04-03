export type Provider = 'anthropic' | 'openai' | 'gemini';

export interface UsageRecord {
  id: string;
  timestamp: Date;
  provider: Provider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  agentId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export interface Budget {
  id: string;
  name: string;
  limitUsd: number;
  period: 'daily' | 'weekly' | 'monthly';
  alertThreshold: number; // 0.8 = alert at 80%
  action: 'alert' | 'block' | 'queue';
}

export interface ScheduledTask {
  id: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  estimatedTokens: number;
  deadline?: Date;
  agentId: string;
  createdAt: Date;
}

export interface BudgetStatus {
  budget: Budget;
  spentUsd: number;
  remainingUsd: number;
  usagePercent: number;
  periodStart: Date;
  periodEnd: Date;
}

// Token pricing per 1M tokens (USD)
export const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 0.8, output: 4 },
  'gpt-4o': { input: 5, output: 15 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
};

export function calcCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = PRICING[model];
  if (!price) return 0;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
