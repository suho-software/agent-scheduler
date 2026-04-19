import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { UsageRecord, Budget, BudgetStatus, TokenQuotaStatus, SessionStats, ClaudePlan, ModelBreakdownRow, CLAUDE_PLAN_LIMITS, CLAUDE_SESSION_LIMITS } from './types.js';

const SCHEMA_VERSION = 3;

export function openDb(path: string = '.agent-scheduler.db'): AgentSchedulerDb {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  migrate(db);
  return new AgentSchedulerDb(db);
}

function migrate(db: Database.Database): void {
  const version: number = (db.pragma('user_version', { simple: true }) as number);
  if (version >= SCHEMA_VERSION) return;

  if (version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_records (
        id          TEXT PRIMARY KEY,
        timestamp   TEXT NOT NULL,
        provider    TEXT NOT NULL,
        model       TEXT NOT NULL,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd    REAL NOT NULL DEFAULT 0,
        agent_id    TEXT,
        task_id     TEXT,
        metadata    TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_records(timestamp);
      CREATE INDEX IF NOT EXISTS idx_usage_provider  ON usage_records(provider);
      CREATE INDEX IF NOT EXISTS idx_usage_agent_id  ON usage_records(agent_id);

      CREATE TABLE IF NOT EXISTS budgets (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        limit_usd        REAL NOT NULL,
        period           TEXT NOT NULL,
        alert_threshold  REAL NOT NULL DEFAULT 0.8,
        action           TEXT NOT NULL DEFAULT 'alert'
      );
    `);
  }

  if (version < 2) {
    db.exec(`
      ALTER TABLE usage_records ADD COLUMN source_id TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_source_id
        ON usage_records(source_id) WHERE source_id IS NOT NULL;
    `);
  }

  if (version < 3) {
    db.exec(`
      ALTER TABLE usage_records ADD COLUMN cache_read_tokens  INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE usage_records ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
    `);
  }

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

export class AgentSchedulerDb {
  constructor(private readonly db: Database.Database) {}

  insertUsage(record: Omit<UsageRecord, 'id' | 'timestamp'>): UsageRecord {
    const id = randomUUID();
    const timestamp = new Date();
    this.db.prepare(`
      INSERT INTO usage_records
        (id, timestamp, provider, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, agent_id, task_id, metadata)
      VALUES
        (@id, @timestamp, @provider, @model, @inputTokens, @outputTokens,
         @cacheReadTokens, @cacheWriteTokens, @costUsd, @agentId, @taskId, @metadata)
    `).run({
      id,
      timestamp: timestamp.toISOString(),
      provider: record.provider,
      model: record.model,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadTokens: record.cacheReadTokens ?? 0,
      cacheWriteTokens: record.cacheWriteTokens ?? 0,
      costUsd: record.costUsd,
      agentId: record.agentId ?? null,
      taskId: record.taskId ?? null,
      metadata: record.metadata ? JSON.stringify(record.metadata) : null,
    });
    return {
      ...record,
      id,
      timestamp,
      cacheReadTokens: record.cacheReadTokens ?? 0,
      cacheWriteTokens: record.cacheWriteTokens ?? 0,
    };
  }

  /**
   * Insert a usage record idempotently using sourceId as the dedup key.
   * Returns { inserted: true } if written, { inserted: false } if already present.
   */
  insertUsageFromSource(
    record: Omit<UsageRecord, 'id' | 'timestamp'> & { timestamp: Date },
    sourceId: string,
  ): { inserted: boolean } {
    const id = randomUUID();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO usage_records
        (id, timestamp, provider, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, agent_id, task_id, metadata, source_id)
      VALUES
        (@id, @timestamp, @provider, @model, @inputTokens, @outputTokens,
         @cacheReadTokens, @cacheWriteTokens, @costUsd, @agentId, @taskId, @metadata, @sourceId)
    `).run({
      id,
      timestamp: record.timestamp.toISOString(),
      provider: record.provider,
      model: record.model,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadTokens: record.cacheReadTokens ?? 0,
      cacheWriteTokens: record.cacheWriteTokens ?? 0,
      costUsd: record.costUsd,
      agentId: record.agentId ?? null,
      taskId: record.taskId ?? null,
      metadata: record.metadata ? JSON.stringify(record.metadata) : null,
      sourceId,
    });
    return { inserted: result.changes > 0 };
  }

  upsertBudget(budget: Omit<Budget, 'id'> & { id?: string }): Budget {
    const id = budget.id ?? randomUUID();
    this.db.prepare(`
      INSERT INTO budgets (id, name, limit_usd, period, alert_threshold, action)
      VALUES (@id, @name, @limitUsd, @period, @alertThreshold, @action)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        limit_usd = excluded.limit_usd,
        period = excluded.period,
        alert_threshold = excluded.alert_threshold,
        action = excluded.action
    `).run({
      id,
      name: budget.name,
      limitUsd: budget.limitUsd,
      period: budget.period,
      alertThreshold: budget.alertThreshold,
      action: budget.action,
    });
    return { ...budget, id };
  }

  getBudgetStatus(budget: Budget): BudgetStatus {
    const { periodStart, periodEnd } = getPeriodBounds(budget.period);
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS spent
      FROM usage_records
      WHERE timestamp >= ? AND timestamp < ?
    `).get(periodStart.toISOString(), periodEnd.toISOString()) as { spent: number };

    const spentUsd = row.spent;
    return {
      budget,
      spentUsd,
      remainingUsd: Math.max(0, budget.limitUsd - spentUsd),
      usagePercent: budget.limitUsd > 0 ? spentUsd / budget.limitUsd : 0,
      periodStart,
      periodEnd,
    };
  }

  /**
   * Calculate token quota status for the current Monday-anchored week,
   * mirroring the logic shown in `claude /usage`.
   */
  getTokenQuotaStatus(plan: ClaudePlan = 'max-5x'): TokenQuotaStatus {
    const { periodStart, periodEnd } = getWeekBounds();
    const limits = CLAUDE_PLAN_LIMITS[plan];

    const rows = this.db.prepare(`
      SELECT model,
             COALESCE(SUM(input_tokens), 0)        AS input_tokens,
             COALESCE(SUM(output_tokens), 0)       AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0)   AS cache_read_tokens,
             COALESCE(SUM(cache_write_tokens), 0)  AS cache_write_tokens
      FROM usage_records
      WHERE timestamp >= ? AND timestamp < ?
      GROUP BY model
    `).all(periodStart.toISOString(), periodEnd.toISOString()) as Array<{
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
    }>;

    let allTokens = 0;
    let sonnetTokens = 0;
    for (const r of rows) {
      const total = r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
      allTokens += total;
      if (r.model.toLowerCase().includes('sonnet')) {
        sonnetTokens += total;
      }
    }

    return {
      plan,
      periodStart,
      periodEnd,
      allTokens,
      sonnetTokens,
      allLimitTokens: limits.weeklyAll,
      sonnetLimitTokens: limits.weeklySonnet,
      allPercent: limits.weeklyAll > 0 ? allTokens / limits.weeklyAll : 0,
      sonnetPercent: limits.weeklySonnet > 0 ? sonnetTokens / limits.weeklySonnet : 0,
    };
  }

  /**
   * Session-level usage — all metrics derived from JSONL files (no stats-cache.json dependency):
   * - currentSession: today's token total from ~/.claude/projects/**​/*.jsonl (today UTC window).
   * - weeklySessions: session count from JSONL (each .jsonl file = one Claude Code session).
   * - weeklyTokens: weekly all-model token quota from the DB and JSONL.
   *
   * Each JSONL file corresponds to exactly one session (filename = session UUID), making
   * session counting straightforward without gap-detection heuristics.
   *
   * @param _statsCachePathOverride - deprecated; kept for API compat, no longer read
   */
  getSessionStats(
    plan: ClaudePlan = 'max-5x',
    _statsCachePathOverride?: string,
    _projectsDirOverride?: string,
  ): SessionStats {
    const limits = CLAUDE_SESSION_LIMITS[plan];
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC date)
    const todayStart = new Date(todayStr + 'T00:00:00Z');

    // Weekly token quota from DB (Paperclip bridge sessions only — kept for diagnostics)
    const weeklyQuota = this.getTokenQuotaStatus(plan);

    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const projectsDir = _projectsDirOverride ?? join(homedir(), '.claude', 'projects');

    // ── JSONL: today's tokens (current session) ────────────────────────────────
    // Replaces stale stats-cache.json. JSONL is updated in real-time by Claude Code.
    const todayTokens = readTokensFromJsonl(projectsDir, todayStart);

    // ── JSONL: weekly session count ────────────────────────────────────────────
    // Each .jsonl file = one session (filename is session UUID). Count files with
    // any assistant-message activity in the 7-day window.
    const { count: weeklyCount, sessionsHitLimit } = readSessionCountFromJsonl(
      projectsDir, sevenDaysAgo, limits.fiveHourTokens,
    );

    // ── JSONL: weekly token aggregation (ground truth) ────────────────────────
    // Covers ALL Claude Code sessions: Paperclip bridge + board direct terminal/IDE.
    const statsCacheWeeklyTokens = readTokensFromJsonl(projectsDir, sevenDaysAgo);

    // Minutes until midnight UTC (daily session window reset)
    let minutesUntilReset: number | null = null;
    if (todayTokens > 0) {
      const tomorrowMidnightUTC = new Date(todayStr);
      tomorrowMidnightUTC.setUTCDate(tomorrowMidnightUTC.getUTCDate() + 1);
      minutesUntilReset = Math.max(0, Math.round((tomorrowMidnightUTC.getTime() - now.getTime()) / 60_000));
    }

    const statsCacheWeeklyAllPercent = weeklyQuota.allLimitTokens > 0
      ? Math.min(1, statsCacheWeeklyTokens / weeklyQuota.allLimitTokens)
      : 0;

    return {
      currentSession: {
        tokens: todayTokens,
        limitTokens: limits.fiveHourTokens,
        percent: limits.fiveHourTokens > 0 ? Math.min(1, todayTokens / limits.fiveHourTokens) : 0,
        windowStart: todayStart,
        minutesUntilReset,
        // true = got real JSONL data for today; false = no activity found yet today
        fromStatsCache: todayTokens > 0,
      },
      weeklySessions: {
        count: weeklyCount,
        quota: limits.weeklySessionQuota,
        percent: limits.weeklySessionQuota > 0 ? weeklyCount / limits.weeklySessionQuota : 0,
        sessionsHitLimit,
      },
      weeklyTokens: {
        allTokens: weeklyQuota.allTokens,
        allLimitTokens: weeklyQuota.allLimitTokens,
        allPercent: Math.min(1, weeklyQuota.allPercent),
        statsCacheAllTokens: statsCacheWeeklyTokens,
        statsCacheAllPercent: statsCacheWeeklyAllPercent,
      },
    };
  }

  listBudgets(): Budget[] {
    return (this.db.prepare('SELECT * FROM budgets').all() as any[]).map(rowToBudget);
  }

  deleteBudget(id: string): boolean {
    const result = this.db.prepare('DELETE FROM budgets WHERE id = ?').run(id);
    return result.changes > 0;
  }

  listUsage(opts: { limit?: number; provider?: string; agentId?: string } = {}): UsageRecord[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.provider) { conditions.push('provider = @provider'); params.provider = opts.provider; }
    if (opts.agentId)  { conditions.push('agent_id = @agentId');  params.agentId = opts.agentId; }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit ?? 100;
    const rows = this.db.prepare(
      `SELECT * FROM usage_records ${where} ORDER BY timestamp DESC LIMIT ${limit}`
    ).all(params) as any[];
    return rows.map(rowToUsage);
  }

  /**
   * Aggregate token usage grouped by model for a given time window.
   * Returns one row per model, sorted by total tokens descending.
   */
  getModelBreakdown(from: Date, to: Date): ModelBreakdownRow[] {
    const rows = this.db.prepare(`
      SELECT model,
             COALESCE(SUM(input_tokens), 0)        AS input_tokens,
             COALESCE(SUM(output_tokens), 0)       AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0)   AS cache_read_tokens,
             COALESCE(SUM(cache_write_tokens), 0)  AS cache_write_tokens,
             COALESCE(SUM(cost_usd), 0)            AS cost_usd
      FROM usage_records
      WHERE timestamp >= ? AND timestamp < ?
      GROUP BY model
      ORDER BY (input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) DESC
    `).all(from.toISOString(), to.toISOString()) as Array<{
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      cost_usd: number;
    }>;

    return rows.map(r => ({
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      costUsd: r.cost_usd,
      totalTokens: r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens,
    }));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Scan ~/.claude/projects/**​/*.jsonl for assistant messages within [windowStart, now).
 * Deduplicates by message id (streaming writes the same message multiple times per file).
 * Uses file mtime as a fast pre-filter to skip sessions older than the window.
 *
 * This is the ground-truth source for ALL Claude Code sessions — Paperclip bridge and
 * board direct terminal/IDE sessions alike — unlike stats-cache.json (which is stale)
 * or the agent-scheduler DB (which only has bridge-routed sessions).
 */
function readTokensFromJsonl(
  projectsDir: string,
  windowStart: Date,
): number {
  let totalTokens = 0;
  const seenIds = new Set<string>();

  let projectDirs: string[];
  try { projectDirs = readdirSync(projectsDir); } catch { return 0; }

  for (const dirName of projectDirs) {
    const dirPath = join(projectsDir, dirName);
    let files: string[];
    try {
      if (!statSync(dirPath).isDirectory()) continue;
      files = readdirSync(dirPath);
    } catch { continue; }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = join(dirPath, file);

      // Fast mtime pre-filter — skip files not touched since the window opened
      try { if (statSync(filePath).mtime < windowStart) continue; } catch { continue; }

      let content: string;
      try { content = readFileSync(filePath, 'utf-8'); } catch { continue; }

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry: { timestamp?: string; message?: { id?: string; role?: string; usage?: Record<string, number> } };
        try { entry = JSON.parse(trimmed); } catch { continue; }

        if (!entry.timestamp || new Date(entry.timestamp) < windowStart) continue;
        const msg = entry.message;
        if (!msg || msg.role !== 'assistant' || !msg.usage) continue;

        // Deduplicate: streaming appends the same message id multiple times
        const mid = msg.id;
        if (mid) {
          if (seenIds.has(mid)) continue;
          seenIds.add(mid);
        }

        const u = msg.usage;
        totalTokens +=
          (u['input_tokens'] ?? 0) +
          (u['output_tokens'] ?? 0) +
          (u['cache_read_input_tokens'] ?? 0) +
          (u['cache_creation_input_tokens'] ?? 0);
      }
    }
  }

  return totalTokens;
}

/**
 * Count Claude Code sessions active within [windowStart, now) from JSONL files.
 * Each .jsonl file corresponds to exactly one session (filename = session UUID).
 * Per-session tokens are computed for sessionsHitLimit tracking.
 */
function readSessionCountFromJsonl(
  projectsDir: string,
  windowStart: Date,
  sessionTokenLimit: number,
): { count: number; sessionsHitLimit: number } {
  let count = 0;
  let sessionsHitLimit = 0;

  let projectDirs: string[];
  try { projectDirs = readdirSync(projectsDir); } catch { return { count: 0, sessionsHitLimit: 0 }; }

  for (const dirName of projectDirs) {
    const dirPath = join(projectsDir, dirName);
    let files: string[];
    try {
      if (!statSync(dirPath).isDirectory()) continue;
      files = readdirSync(dirPath);
    } catch { continue; }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = join(dirPath, file);

      // Fast mtime pre-filter — skip files untouched since window start
      try { if (statSync(filePath).mtime < windowStart) continue; } catch { continue; }

      let content: string;
      try { content = readFileSync(filePath, 'utf-8'); } catch { continue; }

      let sessionTokens = 0;
      let hasActivityInWindow = false;
      const seenIds = new Set<string>();

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry: { timestamp?: string; message?: { id?: string; role?: string; usage?: Record<string, number> } };
        try { entry = JSON.parse(trimmed); } catch { continue; }

        if (!entry.timestamp || new Date(entry.timestamp) < windowStart) continue;
        const msg = entry.message;
        if (!msg || msg.role !== 'assistant' || !msg.usage) continue;

        hasActivityInWindow = true;

        const mid = msg.id;
        if (mid) {
          if (seenIds.has(mid)) continue;
          seenIds.add(mid);
        }

        const u = msg.usage;
        sessionTokens +=
          (u['input_tokens'] ?? 0) +
          (u['output_tokens'] ?? 0) +
          (u['cache_read_input_tokens'] ?? 0) +
          (u['cache_creation_input_tokens'] ?? 0);
      }

      if (hasActivityInWindow) {
        count++;
        if (sessionTokens >= sessionTokenLimit) sessionsHitLimit++;
      }
    }
  }

  return { count, sessionsHitLimit };
}

/** Monday-anchored weekly window, matching claude /usage behaviour. */
function getWeekBounds(): { periodStart: Date; periodEnd: Date } {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon … 6=Sat
  const daysFromMonday = day === 0 ? 6 : day - 1;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysFromMonday);
  const end = new Date(start.getTime() + 7 * 86_400_000);
  return { periodStart: start, periodEnd: end };
}

function getPeriodBounds(period: Budget['period']): { periodStart: Date; periodEnd: Date } {
  const now = new Date();
  if (period === 'daily') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start.getTime() + 86_400_000);
    return { periodStart: start, periodEnd: end };
  }
  if (period === 'weekly') {
    return getWeekBounds();
  }
  // monthly
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { periodStart: start, periodEnd: end };
}

function rowToUsage(row: any): UsageRecord {
  return {
    id: row.id,
    timestamp: new Date(row.timestamp),
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    cacheWriteTokens: row.cache_write_tokens ?? 0,
    costUsd: row.cost_usd,
    agentId: row.agent_id ?? undefined,
    taskId: row.task_id ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

function rowToBudget(row: any): Budget {
  return {
    id: row.id,
    name: row.name,
    limitUsd: row.limit_usd,
    period: row.period,
    alertThreshold: row.alert_threshold,
    action: row.action,
  };
}
