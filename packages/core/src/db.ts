import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { UsageRecord, Budget, BudgetStatus } from './types.js';

const SCHEMA_VERSION = 2;

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

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

export class AgentSchedulerDb {
  constructor(private readonly db: Database.Database) {}

  insertUsage(record: Omit<UsageRecord, 'id' | 'timestamp'>): UsageRecord {
    const id = randomUUID();
    const timestamp = new Date();
    this.db.prepare(`
      INSERT INTO usage_records
        (id, timestamp, provider, model, input_tokens, output_tokens, cost_usd, agent_id, task_id, metadata)
      VALUES
        (@id, @timestamp, @provider, @model, @inputTokens, @outputTokens, @costUsd, @agentId, @taskId, @metadata)
    `).run({
      id,
      timestamp: timestamp.toISOString(),
      provider: record.provider,
      model: record.model,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      costUsd: record.costUsd,
      agentId: record.agentId ?? null,
      taskId: record.taskId ?? null,
      metadata: record.metadata ? JSON.stringify(record.metadata) : null,
    });
    return { ...record, id, timestamp };
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
        (id, timestamp, provider, model, input_tokens, output_tokens, cost_usd, agent_id, task_id, metadata, source_id)
      VALUES
        (@id, @timestamp, @provider, @model, @inputTokens, @outputTokens, @costUsd, @agentId, @taskId, @metadata, @sourceId)
    `).run({
      id,
      timestamp: record.timestamp.toISOString(),
      provider: record.provider,
      model: record.model,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
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

  listBudgets(): Budget[] {
    return (this.db.prepare('SELECT * FROM budgets').all() as any[]).map(rowToBudget);
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

  close(): void {
    this.db.close();
  }
}

function getPeriodBounds(period: Budget['period']): { periodStart: Date; periodEnd: Date } {
  const now = new Date();
  if (period === 'daily') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start.getTime() + 86_400_000);
    return { periodStart: start, periodEnd: end };
  }
  if (period === 'weekly') {
    const day = now.getDay(); // 0 = Sunday
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
    const end = new Date(start.getTime() + 7 * 86_400_000);
    return { periodStart: start, periodEnd: end };
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
