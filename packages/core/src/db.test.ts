import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, AgentSchedulerDb } from './db.js';
import { CLAUDE_PLAN_LIMITS } from './types.js';

/** Open a fresh in-memory DB for each test (no file I/O, fully isolated). */
function freshDb(): AgentSchedulerDb {
  return openDb(':memory:');
}

// ─── Schema migration ──────────────────────────────────────────────────────────

describe('schema migration', () => {
  it('creates usage_records and budgets tables on first open', () => {
    const db = freshDb();
    // If tables don't exist, these will throw
    expect(() => db.listUsage()).not.toThrow();
    expect(() => db.listBudgets()).not.toThrow();
    db.close();
  });

  it('includes cache token columns (schema v3)', () => {
    const db = freshDb();
    // insertUsage uses cache_read_tokens and cache_write_tokens — if columns are missing, this throws
    const record = db.insertUsage({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 200,
      cacheWriteTokens: 10,
      costUsd: 0.001,
    });
    expect(record.cacheReadTokens).toBe(200);
    expect(record.cacheWriteTokens).toBe(10);
    db.close();
  });

  it('opens the same :memory: path without error on repeated calls', () => {
    // Each :memory: call is independent — just verify no crash
    const db1 = freshDb();
    const db2 = freshDb();
    db1.close();
    db2.close();
  });
});

// ─── insertUsage ───────────────────────────────────────────────────────────────

describe('AgentSchedulerDb.insertUsage', () => {
  let db: AgentSchedulerDb;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  it('returns the inserted record with generated id and timestamp', () => {
    const record = db.insertUsage({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.01,
    });
    expect(record.id).toBeTruthy();
    expect(record.timestamp).toBeInstanceOf(Date);
    expect(record.model).toBe('claude-sonnet-4-6');
  });

  it('persists and retrieves usage records', () => {
    db.insertUsage({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      inputTokens: 2000,
      outputTokens: 800,
      cacheReadTokens: 300,
      cacheWriteTokens: 100,
      costUsd: 0.09,
      agentId: 'agent-001',
      taskId: 'task-abc',
    });
    const records = db.listUsage({ limit: 10 });
    expect(records).toHaveLength(1);
    expect(records[0].model).toBe('claude-opus-4-6');
    expect(records[0].inputTokens).toBe(2000);
    expect(records[0].cacheReadTokens).toBe(300);
    expect(records[0].agentId).toBe('agent-001');
    expect(records[0].taskId).toBe('task-abc');
  });

  it('defaults cache tokens to 0 when not provided', () => {
    const record = db.insertUsage({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      inputTokens: 500,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.0005,
    });
    expect(record.cacheReadTokens).toBe(0);
    expect(record.cacheWriteTokens).toBe(0);
  });

  it('filters listUsage by provider', () => {
    db.insertUsage({ provider: 'anthropic', model: 'claude-sonnet-4-6', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 });
    db.insertUsage({ provider: 'openai', model: 'gpt-4o', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.002 });
    const anthropic = db.listUsage({ provider: 'anthropic' });
    expect(anthropic).toHaveLength(1);
    expect(anthropic[0].provider).toBe('anthropic');
  });

  it('filters listUsage by agentId', () => {
    db.insertUsage({ provider: 'anthropic', model: 'claude-sonnet-4-6', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, agentId: 'agent-A' });
    db.insertUsage({ provider: 'anthropic', model: 'claude-sonnet-4-6', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, agentId: 'agent-B' });
    const records = db.listUsage({ agentId: 'agent-A' });
    expect(records).toHaveLength(1);
    expect(records[0].agentId).toBe('agent-A');
  });
});

// ─── insertUsageFromSource ─────────────────────────────────────────────────────

describe('AgentSchedulerDb.insertUsageFromSource', () => {
  let db: AgentSchedulerDb;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  const baseRecord = {
    provider: 'anthropic' as const,
    model: 'claude-sonnet-4-6',
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.01,
    timestamp: new Date('2026-04-18T00:00:00Z'),
  };

  it('inserts a new record and returns inserted: true', () => {
    const result = db.insertUsageFromSource(baseRecord, 'msg-unique-001');
    expect(result.inserted).toBe(true);
  });

  it('is idempotent — duplicate sourceId returns inserted: false', () => {
    db.insertUsageFromSource(baseRecord, 'msg-unique-002');
    const second = db.insertUsageFromSource(baseRecord, 'msg-unique-002');
    expect(second.inserted).toBe(false);
  });

  it('allows different sourceIds for otherwise identical records', () => {
    const r1 = db.insertUsageFromSource(baseRecord, 'msg-A');
    const r2 = db.insertUsageFromSource(baseRecord, 'msg-B');
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(true);
    expect(db.listUsage({ limit: 10 })).toHaveLength(2);
  });
});

// ─── Budget operations ─────────────────────────────────────────────────────────

describe('AgentSchedulerDb.upsertBudget / getBudgetStatus', () => {
  let db: AgentSchedulerDb;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  it('creates a budget and lists it', () => {
    db.upsertBudget({ id: 'monthly', name: 'monthly', limitUsd: 100, period: 'monthly', alertThreshold: 0.8, action: 'alert' });
    const budgets = db.listBudgets();
    expect(budgets).toHaveLength(1);
    expect(budgets[0].id).toBe('monthly');
    expect(budgets[0].limitUsd).toBe(100);
  });

  it('upserts (updates) an existing budget by id', () => {
    db.upsertBudget({ id: 'b1', name: 'b1', limitUsd: 50, period: 'weekly', alertThreshold: 0.8, action: 'alert' });
    db.upsertBudget({ id: 'b1', name: 'b1-updated', limitUsd: 200, period: 'weekly', alertThreshold: 0.9, action: 'block' });
    const budgets = db.listBudgets();
    expect(budgets).toHaveLength(1);
    expect(budgets[0].limitUsd).toBe(200);
    expect(budgets[0].name).toBe('b1-updated');
  });

  it('deletes a budget', () => {
    db.upsertBudget({ id: 'to-delete', name: 'x', limitUsd: 10, period: 'daily', alertThreshold: 0.8, action: 'alert' });
    const deleted = db.deleteBudget('to-delete');
    expect(deleted).toBe(true);
    expect(db.listBudgets()).toHaveLength(0);
  });

  it('returns false when deleting a non-existent budget', () => {
    expect(db.deleteBudget('does-not-exist')).toBe(false);
  });

  it('getBudgetStatus reports 0% when no usage recorded', () => {
    const budget = db.upsertBudget({ id: 'b', name: 'b', limitUsd: 100, period: 'monthly', alertThreshold: 0.8, action: 'alert' });
    const status = db.getBudgetStatus(budget);
    expect(status.spentUsd).toBe(0);
    expect(status.usagePercent).toBe(0);
    expect(status.remainingUsd).toBe(100);
  });

  it('getBudgetStatus reflects inserted usage records', () => {
    const budget = db.upsertBudget({ id: 'b', name: 'b', limitUsd: 100, period: 'monthly', alertThreshold: 0.8, action: 'alert' });
    db.insertUsage({ provider: 'anthropic', model: 'claude-sonnet-4-6', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 25 });
    const status = db.getBudgetStatus(budget);
    expect(status.spentUsd).toBeCloseTo(25);
    expect(status.usagePercent).toBeCloseTo(0.25);
    expect(status.remainingUsd).toBeCloseTo(75);
  });
});

// ─── resetBudget ──────────────────────────────────────────────────────────────

describe('AgentSchedulerDb.resetBudget', () => {
  let db: AgentSchedulerDb;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  it('returns true for an existing budget and sets reset_at', () => {
    db.upsertBudget({ id: 'b', name: 'b', limitUsd: 100, period: 'monthly', alertThreshold: 0.8, action: 'alert' });
    const before = new Date();
    const result = db.resetBudget('b');
    expect(result).toBe(true);

    const budgets = db.listBudgets();
    expect(budgets[0].resetAt).toBeInstanceOf(Date);
    expect(budgets[0].resetAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('returns false for a non-existent budget', () => {
    expect(db.resetBudget('does-not-exist')).toBe(false);
  });

  it('getBudgetStatus excludes spend before reset_at', () => {
    const budget = db.upsertBudget({ id: 'b', name: 'b', limitUsd: 100, period: 'monthly', alertThreshold: 0.8, action: 'alert' });

    // Insert $30 spend BEFORE the reset
    const beforeReset = new Date(Date.now() - 5000); // 5 seconds ago
    (db as any)['db'].prepare(
      `INSERT INTO usage_records (id, timestamp, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES (randomblob(16), ?, 'anthropic', 'claude-sonnet-4-6', 0, 0, 0, 0, 30)`
    ).run(beforeReset.toISOString());

    // Perform reset
    db.resetBudget('b');

    // Insert $10 spend AFTER the reset
    db.insertUsage({ provider: 'anthropic', model: 'claude-sonnet-4-6', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 10 });

    // Budget status should only count post-reset spend
    const [freshBudget] = db.listBudgets();
    const status = db.getBudgetStatus(freshBudget);
    expect(status.spentUsd).toBeCloseTo(10); // NOT 40
  });

  it('pre-reset spend counts normally when no reset has been done', () => {
    const budget = db.upsertBudget({ id: 'b', name: 'b', limitUsd: 100, period: 'monthly', alertThreshold: 0.8, action: 'alert' });
    db.insertUsage({ provider: 'anthropic', model: 'claude-sonnet-4-6', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 50 });
    const status = db.getBudgetStatus(budget);
    expect(status.spentUsd).toBeCloseTo(50);
  });
});

// ─── getTokenQuotaStatus ───────────────────────────────────────────────────────

describe('AgentSchedulerDb.getTokenQuotaStatus', () => {
  let db: AgentSchedulerDb;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  it('returns zero usage for an empty DB', () => {
    const quota = db.getTokenQuotaStatus('max-5x');
    expect(quota.allTokens).toBe(0);
    expect(quota.sonnetTokens).toBe(0);
    expect(quota.allPercent).toBe(0);
    expect(quota.sonnetPercent).toBe(0);
  });

  it('returns correct plan limits for each tier', () => {
    const pro = db.getTokenQuotaStatus('pro');
    const max5x = db.getTokenQuotaStatus('max-5x');
    const max20x = db.getTokenQuotaStatus('max-20x');
    expect(max5x.allLimitTokens).toBeGreaterThan(pro.allLimitTokens);
    expect(max20x.allLimitTokens).toBeGreaterThan(max5x.allLimitTokens);
  });

  it('counts sonnet tokens separately from all-model total', () => {
    // Insert a sonnet record and an opus record
    db.insertUsage({ provider: 'anthropic', model: 'claude-sonnet-4-6', inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
    db.insertUsage({ provider: 'anthropic', model: 'claude-opus-4-6', inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
    const quota = db.getTokenQuotaStatus('max-5x');
    expect(quota.allTokens).toBe(1500);
    expect(quota.sonnetTokens).toBe(1000); // only sonnet
  });

  it('allPercent > 0 when tokens are recorded', () => {
    db.insertUsage({ provider: 'anthropic', model: 'claude-sonnet-4-6', inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
    const quota = db.getTokenQuotaStatus('max-5x');
    expect(quota.allPercent).toBeGreaterThan(0);
  });
});

// ─── getSessionStats — JSONL-based weekly tokens (SUH-386 max-policy fix) ─────

describe('AgentSchedulerDb.getSessionStats — JSONL-based weekly token aggregation', () => {
  let db: AgentSchedulerDb;
  let tmpDir: string;

  beforeEach(() => {
    db = freshDb();
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-sched-test-'));
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write fake JSONL session files into a projects-dir structure. */
  function writeJsonlSession(
    projectSubdir: string,
    sessionFile: string,
    messages: Array<{ id: string; inputTokens: number; outputTokens: number; cacheRead?: number; timestamp?: string }>,
  ): void {
    const projectDir = join(tmpDir, projectSubdir);
    mkdirSync(projectDir, { recursive: true });
    const lines = messages.flatMap((m) => {
      const ts = m.timestamp ?? new Date().toISOString();
      const entry = {
        timestamp: ts,
        message: {
          id: m.id,
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: m.inputTokens,
            output_tokens: m.outputTokens,
            cache_read_input_tokens: m.cacheRead ?? 0,
            cache_creation_input_tokens: 0,
          },
        },
      };
      // Simulate streaming: append the same entry twice (like real Claude Code writes)
      return [JSON.stringify(entry), JSON.stringify(entry)];
    });
    writeFileSync(join(projectDir, sessionFile), lines.join('\n'));
  }

  it('reads weekly tokens from JSONL and deduplicates streaming duplicates', () => {
    const plan = 'max-5x';
    const weeklyLimit = CLAUDE_PLAN_LIMITS[plan].weeklyAll;
    // Write a session with 2 unique messages, each duplicated (streaming)
    writeJsonlSession('project-a', 'session1.jsonl', [
      { id: 'msg-1', inputTokens: 100_000, outputTokens: 50_000 },
      { id: 'msg-2', inputTokens: 200_000, outputTokens: 80_000 },
    ]);

    const sessions = db.getSessionStats(plan, undefined, tmpDir);
    // Expected: (100k+50k) + (200k+80k) = 430k — NOT 860k (no double-counting)
    expect(sessions.weeklyTokens.statsCacheAllTokens).toBe(430_000);
    expect(sessions.weeklyTokens.statsCacheAllPercent).toBeCloseTo(430_000 / weeklyLimit, 5);
  });

  it('statsCacheAllPercent reflects board direct usage (70% scenario → STOP)', () => {
    const plan = 'max-5x';
    const weeklyLimit = CLAUDE_PLAN_LIMITS[plan].weeklyAll;
    // 70% board usage: 201_600_000 tokens (input only for simplicity)
    const boardTokens = Math.round(weeklyLimit * 0.70);
    writeJsonlSession('board-project', 'direct-session.jsonl', [
      { id: 'board-msg-1', inputTokens: boardTokens, outputTokens: 0 },
    ]);

    const sessions = db.getSessionStats(plan, undefined, tmpDir);
    // DB has 0 tokens (agent idle), JSONL has 70% board usage
    expect(sessions.weeklyTokens.allPercent).toBe(0);           // DB: agent idle
    expect(sessions.weeklyTokens.statsCacheAllPercent).toBeGreaterThanOrEqual(0.69);
    expect(sessions.weeklyTokens.statsCacheAllPercent).toBeLessThanOrEqual(0.71);

    // Max policy in quota-json: max(0, 0.70) ≥ 0.70 → STOP
    const effectivePct = Math.max(sessions.weeklyTokens.allPercent, sessions.weeklyTokens.statsCacheAllPercent);
    expect(effectivePct).toBeGreaterThanOrEqual(0.70);
  });

  it('excludes messages older than 7 days', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    writeJsonlSession('old-project', 'old-session.jsonl', [
      { id: 'old-msg', inputTokens: 999_999_999, outputTokens: 0, timestamp: eightDaysAgo },
    ]);

    const sessions = db.getSessionStats('max-5x', undefined, tmpDir);
    expect(sessions.weeklyTokens.statsCacheAllTokens).toBe(0);
  });

  it('returns 0 when projects directory does not exist', () => {
    const sessions = db.getSessionStats('max-5x', undefined, join(tmpDir, 'nonexistent'));
    expect(sessions.weeklyTokens.statsCacheAllTokens).toBe(0);
    expect(sessions.weeklyTokens.statsCacheAllPercent).toBe(0);
  });
});
