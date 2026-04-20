export type Provider = 'anthropic' | 'openai' | 'gemini';

export interface UsageRecord {
  id: string;
  timestamp: Date;
  provider: Provider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
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

/** Claude subscription plan tiers and their weekly token limits */
export const CLAUDE_PLAN_LIMITS = {
  'pro':     { weeklyAll: 50_000_000,    weeklySonnet: 175_000_000 },
  'max-5x':  { weeklyAll: 288_000_000,   weeklySonnet: 1_008_000_000 },
  'max-20x': { weeklyAll: 1_152_000_000, weeklySonnet: 4_032_000_000 },
} as const;

export type ClaudePlan = keyof typeof CLAUDE_PLAN_LIMITS;

/** Aggregated token usage for a single model within a time window. */
export interface ModelBreakdownRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface TokenQuotaStatus {
  plan: ClaudePlan;
  periodStart: Date;
  periodEnd: Date;
  allTokens: number;
  sonnetTokens: number;
  allLimitTokens: number;
  sonnetLimitTokens: number;
  allPercent: number;
  sonnetPercent: number;
}

/** Per-session (5-hour window) token limits per plan. */
export const CLAUDE_SESSION_LIMITS: Record<ClaudePlan, { fiveHourTokens: number; weeklySessionQuota: number }> = {
  'pro':     { fiveHourTokens:  1_000_000, weeklySessionQuota: 50 },
  'max-5x':  { fiveHourTokens:  5_000_000, weeklySessionQuota: 57 },
  'max-20x': { fiveHourTokens: 20_000_000, weeklySessionQuota: 57 },
};

/** Session-level usage metrics (current session + weekly session count + weekly token quota). */
export interface SessionStats {
  /**
   * Current session token usage derived from ~/.claude/projects/**​/*.jsonl (today UTC window).
   * This mirrors `claude /usage` "Current session" semantics.
   * percent is always in [0, 1] range.
   * When no JSONL activity exists for today, tokens=0 and percent=0.
   */
  currentSession: {
    tokens: number;
    limitTokens: number;
    percent: number;
    windowStart: Date;
    /** Minutes until midnight UTC (session window reset). Null when no activity today. */
    minutesUntilReset: number | null;
    /** True when JSONL files contain activity for today; false when no today activity found. */
    fromStatsCache: boolean;
  };
  weeklySessions: {
    count: number;
    quota: number;
    percent: number;
    /** Sessions in the last 7 days that exhausted the token limit. */
    sessionsHitLimit: number;
  };
  /**
   * Weekly subscription token utilization from the agent-scheduler DB.
   * This is the authoritative signal for subscription quota — use this for throttle decisions.
   * Aggregates all agents sharing the DB; always in [0, 1] range.
   */
  weeklyTokens: {
    allTokens: number;
    allLimitTokens: number;
    /** Percent from agent-scheduler DB (Paperclip bridge sessions only). Always in [0, 1]. */
    allPercent: number;
    /**
     * Percent computed from ~/.claude/stats-cache.json (all board Claude Code sessions, including
     * direct terminal/IDE sessions that bypass the Paperclip bridge). Always in [0, 1].
     * 0 when stats-cache has no weekly data.
     */
    statsCacheAllTokens: number;
    statsCacheAllPercent: number;
  };
}

// Token pricing per 1M tokens (USD)
export const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 0.8, output: 4 },
  'gpt-4o': { input: 5, output: 15 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
};

/**
 * Look up pricing for a model, using prefix matching to handle versioned names
 * (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5").
 */
function getPricing(model: string): { input: number; output: number } | undefined {
  if (PRICING[model]) return PRICING[model];
  const key = Object.keys(PRICING).find(k => model.startsWith(k));
  return key ? PRICING[key] : undefined;
}

export function calcCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = getPricing(model);
  if (!price) return 0;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/**
 * Calculate cost for Claude Code session data, which includes cache tokens.
 * Cache read tokens cost 10% of regular input; cache write tokens cost 125%.
 */
export function calcCostUsdWithCache(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number {
  const price = getPricing(model);
  if (!price) return 0;
  return (
    inputTokens * price.input +
    outputTokens * price.output +
    cacheReadTokens * price.input * 0.1 +
    cacheWriteTokens * price.input * 1.25
  ) / 1_000_000;
}
