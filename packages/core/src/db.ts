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

    // ── JSONL: single scan for both session analysis and weekly token total ────
    // Collect all (timestamp, tokens) pairs for the 7-day window in one pass.
    const tokenEntries = collectTokenTimestamps(projectsDir, sevenDaysAgo);

    // ── ccusage-style fixed 5h billing blocks (Option E1) ────────────────────
    // Ported from ryoppippi/ccusage `identifySessionBlocks` (MIT licence).
    // Block start = floorToHour(firstEntry). New block when:
    //   timeSinceBlockStart > 5h  OR  timeSinceLastEntry > 5h
    // This matches Anthropic's fixed billing-window grid, not an idle-rolling window.
    const blocks = identifySessionBlocks(tokenEntries, 5, now);
    const activeBlock = blocks.find(b => b.isActive) ?? null;
    const sessionResult = {
      count: blocks.length,
      sessionsHitLimit: blocks.filter(b => b.tokens >= limits.fiveHourTokens).length,
      currentSessionTokens: activeBlock?.tokens ?? 0,
      minutesUntilReset: activeBlock?.minutesUntilReset ?? null,
    };

    // Weekly token total: free byproduct of the timestamp collection
    const statsCacheWeeklyTokens = tokenEntries.reduce((s, e) => s + e.tokens, 0);

    const statsCacheWeeklyAllPercent = weeklyQuota.allLimitTokens > 0
      ? Math.min(1, statsCacheWeeklyTokens / weeklyQuota.allLimitTokens)
      : 0;

    return {
      currentSession: {
        tokens: sessionResult.currentSessionTokens,
        limitTokens: limits.fiveHourTokens,
        percent: limits.fiveHourTokens > 0 ? Math.min(1, sessionResult.currentSessionTokens / limits.fiveHourTokens) : 0,
        windowStart: todayStart,
        minutesUntilReset: sessionResult.minutesUntilReset,
        // true = there is an active session within last 5h; false = session idle/none
        fromStatsCache: sessionResult.currentSessionTokens > 0,
      },
      weeklySessions: {
        count: sessionResult.count,
        quota: limits.weeklySessionQuota,
        percent: limits.weeklySessionQuota > 0 ? sessionResult.count / limits.weeklySessionQuota : 0,
        sessionsHitLimit: sessionResult.sessionsHitLimit,
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

interface TimestampedTokens {
  timestamp: Date;
  tokens: number;
}

/**
 * Scan ~/.claude/projects/**​/*.jsonl and collect (timestamp, tokens) pairs for every
 * deduplicated assistant message within [windowStart, now).
 *
 * Returns entries sorted by timestamp ascending — ready for idle-window session analysis.
 * Uses file mtime as a fast pre-filter to skip sessions outside the window.
 *
 * This is the ground-truth source for ALL Claude Code sessions — Paperclip bridge and
 * board direct terminal/IDE sessions alike.
 */
function collectTokenTimestamps(
  projectsDir: string,
  windowStart: Date,
): TimestampedTokens[] {
  const entries: TimestampedTokens[] = [];
  const seenIds = new Set<string>();

  let projectDirs: string[];
  try { projectDirs = readdirSync(projectsDir); } catch { return []; }

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
      try { if (statSync(filePath).mtime < windowStart) continue; } catch { continue; }

      let content: string;
      try { content = readFileSync(filePath, 'utf-8'); } catch { continue; }

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry: { timestamp?: string; message?: { id?: string; role?: string; usage?: Record<string, number> } };
        try { entry = JSON.parse(trimmed); } catch { continue; }

        if (!entry.timestamp) continue;
        const ts = new Date(entry.timestamp);
        if (ts < windowStart) continue;

        const msg = entry.message;
        if (!msg || msg.role !== 'assistant' || !msg.usage) continue;

        // Deduplicate: streaming appends the same message id multiple times
        const mid = msg.id;
        if (mid) { if (seenIds.has(mid)) continue; seenIds.add(mid); }

        const u = msg.usage;
        const tokens =
          (u['input_tokens'] ?? 0) +
          (u['output_tokens'] ?? 0) +
          (u['cache_read_input_tokens'] ?? 0) +
          (u['cache_creation_input_tokens'] ?? 0);

        entries.push({ timestamp: ts, tokens });
      }
    }
  }

  entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return entries;
}

/** Floor a timestamp to the start of its UTC hour (used to anchor session blocks). */
function floorToHour(ts: Date): Date {
  const floored = new Date(ts);
  floored.setUTCMinutes(0, 0, 0);
  return floored;
}

interface SessionBlock {
  startTime: Date;      // floored to UTC hour
  endTime: Date;        // startTime + sessionDurationHours
  tokens: number;
  lastActivity: Date;
  isActive: boolean;
  minutesUntilReset: number | null;
}

/**
 * Port of ccusage `identifySessionBlocks` (MIT licence, ryoppippi/ccusage).
 *
 * A new billing block starts when EITHER:
 *   - time since block start  > sessionDurationHours, OR
 *   - time since last entry   > sessionDurationHours
 *
 * Each block's start is floored to the UTC hour of its first entry, giving a
 * fixed 5-hour window that matches Anthropic's rate-limit billing grid rather
 * than an idle-rolling window.
 *
 * The last block is marked `isActive` when:
 *   - now < endTime (block window hasn't elapsed), AND
 *   - now - lastActivity < sessionDurationMs (not idle-expired)
 * `minutesUntilReset` counts down from endTime (fixed), not last activity.
 */
function identifySessionBlocks(
  entries: TimestampedTokens[],
  sessionDurationHours: number,
  now: Date,
): SessionBlock[] {
  if (entries.length === 0) return [];

  const sessionDurationMs = sessionDurationHours * 60 * 60 * 1000;
  const blocks: SessionBlock[] = [];

  let blockStart: Date | null = null;
  let blockTokens = 0;
  let lastActivity: Date | null = null;

  for (const { timestamp, tokens } of entries) {
    if (blockStart === null) {
      blockStart = floorToHour(timestamp);
      blockTokens = tokens;
      lastActivity = timestamp;
    } else {
      const timeSinceBlockStart = timestamp.getTime() - blockStart.getTime();
      const timeSinceLastEntry = timestamp.getTime() - lastActivity!.getTime();

      if (timeSinceBlockStart > sessionDurationMs || timeSinceLastEntry > sessionDurationMs) {
        // Close the current block
        blocks.push({
          startTime: blockStart,
          endTime: new Date(blockStart.getTime() + sessionDurationMs),
          tokens: blockTokens,
          lastActivity: lastActivity!,
          isActive: false,
          minutesUntilReset: null,
        });
        // Open a new block anchored at this entry's floored hour
        blockStart = floorToHour(timestamp);
        blockTokens = tokens;
        lastActivity = timestamp;
      } else {
        blockTokens += tokens;
        lastActivity = timestamp;
      }
    }
  }

  // Close final block
  if (blockStart !== null) {
    blocks.push({
      startTime: blockStart,
      endTime: new Date(blockStart.getTime() + sessionDurationMs),
      tokens: blockTokens,
      lastActivity: lastActivity!,
      isActive: false,
      minutesUntilReset: null,
    });
  }

  // Mark the last block active if now is still within its window and not idle-expired
  if (blocks.length > 0) {
    const last = blocks[blocks.length - 1];
    const isActive =
      now < last.endTime &&
      now.getTime() - last.lastActivity.getTime() < sessionDurationMs;
    if (isActive) {
      last.isActive = true;
      last.minutesUntilReset = Math.max(0, Math.round((last.endTime.getTime() - now.getTime()) / 60_000));
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Legacy token-only scan (kept for weekly aggregate; uses same dedup logic)
// ---------------------------------------------------------------------------
/** @deprecated Use collectTokenTimestamps + sum instead when session data is also needed. */
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
 * Count distinct Claude Code sessions active within [windowStart, now) using
 * the `sessionId` field present on every JSONL entry.
 *
 * Only sessions that have at least one assistant message with token usage are
 * counted — this excludes import/attachment-only files that never consumed LLM quota.
 * Per-session token totals are accumulated for sessionsHitLimit tracking.
 */
function readSessionCountFromJsonl(
  projectsDir: string,
  windowStart: Date,
  sessionTokenLimit: number,
): { count: number; sessionsHitLimit: number } {
  // sessionId → total tokens (only for sessions with assistant usage in window)
  const sessionTokenMap = new Map<string, number>();
  const seenMsgIds = new Set<string>(); // global dedup across all files

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

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry: { timestamp?: string; sessionId?: string; message?: { id?: string; role?: string; usage?: Record<string, number> } };
        try { entry = JSON.parse(trimmed); } catch { continue; }

        if (!entry.timestamp || new Date(entry.timestamp) < windowStart) continue;
        const sessionId = entry.sessionId;
        if (!sessionId) continue;

        const msg = entry.message;
        if (!msg || msg.role !== 'assistant' || !msg.usage) continue;

        // Deduplicate: streaming writes the same message id multiple times
        const mid = msg.id;
        if (mid) {
          if (seenMsgIds.has(mid)) continue;
          seenMsgIds.add(mid);
        }

        const u = msg.usage;
        const tokens =
          (u['input_tokens'] ?? 0) +
          (u['output_tokens'] ?? 0) +
          (u['cache_read_input_tokens'] ?? 0) +
          (u['cache_creation_input_tokens'] ?? 0);

        sessionTokenMap.set(sessionId, (sessionTokenMap.get(sessionId) ?? 0) + tokens);
      }
    }
  }

  let sessionsHitLimit = 0;
  for (const tokens of sessionTokenMap.values()) {
    if (tokens >= sessionTokenLimit) sessionsHitLimit++;
  }

  return { count: sessionTokenMap.size, sessionsHitLimit };
}

/**
 * Find the most recently active Claude Code session and return its token usage
 * within the given window.
 *
 * "Current session" = the session from the most recently modified .jsonl file,
 * scoped to [windowStart, now) so we count only the active window's tokens.
 * JSONL files accumulate all conversation history; without a time filter the total
 * would include months of prior usage rather than the live session.
 *
 * @param windowStart - Only count tokens at or after this timestamp.
 *   Callers should pass `now - 5h` to match Claude's per-session rolling window.
 */
function readCurrentSessionFromJsonl(
  projectsDir: string,
  windowStart: Date,
): { tokens: number; sessionId: string } | null {
  let latestMtime = 0;
  let latestFilePath: string | null = null;

  let projectDirs: string[];
  try { projectDirs = readdirSync(projectsDir); } catch { return null; }

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
      try {
        const mtime = statSync(filePath).mtime.getTime();
        if (mtime > latestMtime) { latestMtime = mtime; latestFilePath = filePath; }
      } catch { continue; }
    }
  }

  if (!latestFilePath) return null;

  let content: string;
  try { content = readFileSync(latestFilePath, 'utf-8'); } catch { return null; }

  // Session UUID is the filename (without .jsonl extension)
  const sessionId = latestFilePath.split('/').pop()!.slice(0, -'.jsonl'.length);

  let tokens = 0;
  const seenIds = new Set<string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: { timestamp?: string; message?: { id?: string; role?: string; usage?: Record<string, number> } };
    try { entry = JSON.parse(trimmed); } catch { continue; }

    // Only count tokens within the session window
    if (!entry.timestamp || new Date(entry.timestamp) < windowStart) continue;

    const msg = entry.message;
    if (!msg || msg.role !== 'assistant' || !msg.usage) continue;

    const mid = msg.id;
    if (mid) { if (seenIds.has(mid)) continue; seenIds.add(mid); }

    const u = msg.usage;
    tokens +=
      (u['input_tokens'] ?? 0) +
      (u['output_tokens'] ?? 0) +
      (u['cache_read_input_tokens'] ?? 0) +
      (u['cache_creation_input_tokens'] ?? 0);
  }

  return { tokens, sessionId };
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
