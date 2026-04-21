#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { createInterface } from 'node:readline/promises';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface as createLineInterface } from 'node:readline';
import { openDb, calcCostUsdWithCache, CLAUDE_PLAN_LIMITS, ClaudePlan, ModelBreakdownRow } from '@agent-scheduler/core';

const CONFIG_PATH = join(homedir(), '.agent-scheduler.json');

interface Config {
  dbPath: string;
  defaultBudgetUsd: number;
  plan: ClaudePlan;
}

function loadConfig(): Config {
  if (existsSync(CONFIG_PATH)) {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Partial<Config>;
    return {
      dbPath: raw.dbPath ?? join(homedir(), '.agent-scheduler.db'),
      defaultBudgetUsd: raw.defaultBudgetUsd ?? 10,
      plan: (raw.plan as ClaudePlan) ?? 'max-5x',
    };
  }
  process.stderr.write(
    chalk.yellow('  ⚠ No ~/.agent-scheduler.json found — using default plan: max-5x\n') +
    chalk.gray('    Run: agent-scheduler init  (to set your actual plan: pro / max-5x / max-20x)\n')
  );
  return { dbPath: join(homedir(), '.agent-scheduler.db'), defaultBudgetUsd: 10, plan: 'max-5x' };
}

function saveConfig(config: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function buildBar(pct: number, width = 20): string {
  const filled = Math.min(Math.round((pct / 100) * width), width);
  const empty = width - filled;
  const color = pct >= 100 ? chalk.red : pct >= 80 ? chalk.yellow : chalk.green;
  return '[' + color('█'.repeat(filled)) + chalk.gray('░'.repeat(empty)) + ']';
}

const program = new Command();

program
  .name('agent-scheduler')
  .description('AI API usage monitoring and budget scheduling')
  .version('0.1.0');

// ─── init ────────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Initialize agent-scheduler (interactive wizard)')
  .action(async () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const existing = loadConfig();

    console.log(chalk.bold.cyan('\n  agent-scheduler init\n'));

    const dbPath = await rl.question(
      chalk.gray(`  DB path [${existing.dbPath}]: `)
    );
    const budgetStr = await rl.question(
      chalk.gray(`  Default monthly budget USD [${existing.defaultBudgetUsd}]: `)
    );
    const planStr = await rl.question(
      chalk.gray(`  Claude plan (pro / max-5x / max-20x) [${existing.plan}]: `)
    );
    rl.close();

    const planInput = planStr.trim() || existing.plan;
    const validPlans: ClaudePlan[] = ['pro', 'max-5x', 'max-20x'];
    const plan: ClaudePlan = (validPlans.includes(planInput as ClaudePlan) ? planInput : existing.plan) as ClaudePlan;

    const config: Config = {
      dbPath: dbPath.trim() || existing.dbPath,
      defaultBudgetUsd: budgetStr.trim() ? parseFloat(budgetStr) : existing.defaultBudgetUsd,
      plan,
    };

    saveConfig(config);

    const db = openDb(config.dbPath);
    db.upsertBudget({
      id: 'default',
      name: 'default',
      limitUsd: config.defaultBudgetUsd,
      period: 'monthly',
      alertThreshold: 0.8,
      action: 'alert',
    });
    db.close();

    console.log(chalk.green('\n  ✓ Initialized!'));
    console.log(chalk.gray(`    DB:     ${config.dbPath}`));
    console.log(chalk.gray(`    Budget: $${config.defaultBudgetUsd}/month`));
    console.log(chalk.gray(`    Plan:   ${config.plan}\n`));
  });

// ─── status ──────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show usage percentages against configured budgets')
  .action(() => {
    const config = loadConfig();
    const db = openDb(config.dbPath);
    const budgets = db.listBudgets();
    const usage = db.listUsage({ limit: 100000 });
    db.close();

    const now = new Date();

    // ── Compute period boundaries ────────────────────────────────────────────
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd   = new Date(todayStart.getTime() + 86_400_000);

    const weekDay   = now.getDay();
    const weekDiff  = weekDay === 0 ? -6 : 1 - weekDay;  // Monday = week start
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + weekDiff);
    const weekEnd   = new Date(weekStart.getTime() + 7 * 86_400_000);

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const costIn = (from: Date, to: Date, model?: string) =>
      usage
        .filter(r => r.timestamp >= from && r.timestamp < to &&
          (!model || r.model.startsWith(model)))
        .reduce((s, r) => s + r.costUsd, 0);

    const todayCost  = costIn(todayStart, todayEnd);
    const weekCost   = costIn(weekStart, weekEnd);
    const monthCost  = costIn(monthStart, monthEnd);
    const weekSonnet = costIn(weekStart, weekEnd, 'claude-sonnet');

    // ── Format helpers ───────────────────────────────────────────────────────
    const BAR_W = 42;
    function bar(pct: number): string {
      const clamped = Math.min(pct / 100, 1);
      const filled  = Math.round(clamped * BAR_W);
      const empty   = BAR_W - filled;
      const color   = pct >= 100 ? chalk.red : pct >= 80 ? chalk.yellow : chalk.cyan;
      return color('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
    }
    function pctLabel(pct: number): string {
      const color = pct >= 100 ? chalk.red : pct >= 80 ? chalk.yellow : chalk.white;
      return color(pct.toFixed(0) + '% used');
    }
    function resetLabel(d: Date): string {
      const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Seoul', timeZoneName: 'short' };
      return chalk.gray('Resets ' + d.toLocaleString('en-US', options).replace(':00 ', ' '));
    }
    function section(label: string, cost: number, limitUsd: number, resetsAt: Date): void {
      const pct = limitUsd > 0 ? (cost / limitUsd) * 100 : 0;
      console.log(chalk.bold(`\n  ${label}`));
      console.log(`  ${bar(pct)}  ${pctLabel(pct)}`);
      console.log(`  ${resetLabel(resetsAt)}   ${chalk.gray('$' + cost.toFixed(2) + ' / $' + limitUsd)}`);
    }

    // ── Find budget limits (fall back to defaults if not set) ────────────────
    const budgetMap = Object.fromEntries(budgets.map(b => [b.id, b.limitUsd]));
    const dailyLimit   = budgetMap['daily']         ?? budgetMap['default'] ?? 0;
    const weeklyLimit  = budgetMap['weekly']         ?? 0;
    const sonnetLimit  = budgetMap['weekly-sonnet']  ?? 0;
    const monthlyLimit = budgetMap['monthly']        ?? 0;

    console.log(chalk.bold.cyan('\n  agent-scheduler /usage\n'));
    console.log(chalk.gray('  ─'.repeat(26)));

    if (dailyLimit > 0)   section('Today',                        todayCost,  dailyLimit,   todayEnd);
    if (weeklyLimit > 0)  section('Current week (all models)',     weekCost,   weeklyLimit,  weekEnd);
    if (sonnetLimit > 0)  section('Current week (Sonnet only)',    weekSonnet, sonnetLimit,  weekEnd);
    if (monthlyLimit > 0) section('Current month',                 monthCost,  monthlyLimit, monthEnd);

    if (dailyLimit === 0 && weeklyLimit === 0 && monthlyLimit === 0) {
      console.log(chalk.yellow('\n  No budgets configured — run: agent-scheduler budget set <name> <usd>'));
      console.log(chalk.gray('  Suggested: agent-scheduler budget set weekly 150 --period weekly'));
      console.log(chalk.gray('             agent-scheduler budget set monthly 500 --period monthly\n'));
      // Show raw summary as fallback
      console.log(`  Today       $${todayCost.toFixed(4)}`);
      console.log(`  This week   $${weekCost.toFixed(4)}`);
      console.log(`  This month  $${monthCost.toFixed(4)}`);
    }

    console.log();
  });

// ─── budget ──────────────────────────────────────────────────────────────────
const budgetCmd = program
  .command('budget')
  .description('Manage budgets');

budgetCmd
  .command('set <name> <limitUsd>')
  .description('Create or update a named budget')
  .option('--period <period>', 'daily | weekly | monthly', 'monthly')
  .option('--action <action>', 'alert | block | queue', 'alert')
  .option('--threshold <threshold>', 'Alert threshold 0-1', '0.8')
  .action((name: string, limitUsdStr: string, opts: { period: string; action: string; threshold: string }) => {
    const limitUsd = parseFloat(limitUsdStr);
    if (isNaN(limitUsd) || limitUsd <= 0) {
      console.error(chalk.red('  limitUsd must be a positive number'));
      process.exit(1);
    }
    const period = opts.period as 'daily' | 'weekly' | 'monthly';
    if (!['daily', 'weekly', 'monthly'].includes(period)) {
      console.error(chalk.red('  --period must be daily, weekly, or monthly'));
      process.exit(1);
    }
    const action = opts.action as 'alert' | 'block' | 'queue';
    const alertThreshold = parseFloat(opts.threshold);

    const config = loadConfig();
    const db = openDb(config.dbPath);
    db.upsertBudget({ id: name, name, limitUsd, period, alertThreshold, action });
    db.close();
    console.log(chalk.green(`\n  ✓ Budget '${name}': $${limitUsd}/${period} (action: ${action})\n`));
  });

budgetCmd
  .command('delete <id>')
  .description('Delete a budget by id')
  .action((id: string) => {
    const config = loadConfig();
    const db = openDb(config.dbPath);
    const deleted = db.deleteBudget(id);
    db.close();
    if (deleted) {
      console.log(chalk.green(`\n  ✓ Budget '${id}' deleted.\n`));
    } else {
      console.log(chalk.yellow(`\n  Budget '${id}' not found.\n`));
    }
  });

budgetCmd
  .command('reset <id>')
  .description('Reset a budget spend counter to now (non-destructive — old records preserved)')
  .action((id: string) => {
    const config = loadConfig();
    const db = openDb(config.dbPath);
    const reset = db.resetBudget(id);
    db.close();
    if (reset) {
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      console.log(chalk.green(`\n  ✓ Budget '${id}' reset at ${now} UTC.`));
      console.log(chalk.gray('    Spend will be counted from this moment within the current period.\n'));
    } else {
      console.log(chalk.yellow(`\n  Budget '${id}' not found.\n`));
    }
  });

budgetCmd
  .command('list')
  .description('List all configured budgets')
  .action(() => {
    const config = loadConfig();
    const db = openDb(config.dbPath);
    const budgets = db.listBudgets();
    db.close();

    if (budgets.length === 0) {
      console.log(chalk.gray('\n  No budgets configured.\n'));
      return;
    }

    console.log(chalk.bold.cyan('\n  Budgets:\n'));
    for (const b of budgets) {
      console.log(`  ${chalk.bold(b.name)}`);
      console.log(`    Limit:     $${b.limitUsd}/${b.period}`);
      console.log(`    Threshold: ${(b.alertThreshold * 100).toFixed(0)}%`);
      console.log(`    Action:    ${b.action}`);
      if (b.resetAt) {
        console.log(chalk.gray(`    Reset at:  ${b.resetAt.toISOString().replace('T', ' ').slice(0, 19)} UTC`));
      }
    }
    console.log();
  });

// ─── usage (top-level: claude /usage style quota view) ───────────────────────
const usageCmd = program
  .command('usage')
  .description('Show token quota status (claude /usage style) — or use subcommands')
  .action(() => {
    const config = loadConfig();
    const db = openDb(config.dbPath);
    const quota = db.getTokenQuotaStatus(config.plan);
    const sessions = db.getSessionStats(config.plan);
    db.close();

    const BAR_W = 42;
    function bar(pct: number): string {
      const clamped = Math.min(pct, 1);
      const filled  = Math.round(clamped * BAR_W);
      const empty   = BAR_W - filled;
      const color   = pct >= 1 ? chalk.red : pct >= 0.8 ? chalk.yellow : chalk.cyan;
      return color('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
    }
    function pctLabel(pct: number): string {
      const color = pct >= 1 ? chalk.red : pct >= 0.8 ? chalk.yellow : chalk.white;
      return color((pct * 100).toFixed(1) + '% used');
    }
    function fmtTokens(n: number): string {
      if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
      if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
      return String(n);
    }
    const resetDate = quota.periodEnd.toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      timeZone: 'Asia/Seoul', timeZoneName: 'short',
    });

    console.log(chalk.bold.cyan('\n  agent-scheduler usage\n'));
    console.log(chalk.gray('  ─'.repeat(26)));
    console.log(chalk.gray(`  Plan: ${quota.plan}   Week: ${quota.periodStart.toISOString().slice(0,10)} → ${quota.periodEnd.toISOString().slice(0,10)}`));
    console.log(chalk.gray(`  Resets ${resetDate}\n`));

    // ── Current session (today from JSONL files) ──────────────────────────────
    const cs = sessions.currentSession;
    const sourceNote = cs.fromStatsCache ? chalk.gray(' · via JSONL') : chalk.yellow(' · no JSONL activity today');
    const resetLabel = cs.minutesUntilReset !== null
      ? chalk.gray(` · reset in ${cs.minutesUntilReset}m`)
      : '';
    console.log(chalk.bold(`  Current session`) + chalk.gray(`  (today UTC: ${cs.windowStart.toISOString().slice(0,10)})`) + sourceNote + resetLabel);
    console.log(`  ${bar(cs.percent)}  ${pctLabel(cs.percent)}`);
    console.log(chalk.gray(`  ${fmtTokens(cs.tokens)} / ${fmtTokens(cs.limitTokens)} tokens\n`));

    // ── Weekly sessions ──────────────────────────────────────────────────────
    const ws = sessions.weeklySessions;
    const hitLabel = ws.sessionsHitLimit > 0 ? chalk.gray(`  (${ws.sessionsHitLimit} hit token limit)`) : '';
    console.log(chalk.bold('  Weekly sessions') + chalk.gray('  (last 7 days)'));
    console.log(`  ${bar(ws.percent)}  ${pctLabel(ws.percent)}${hitLabel}`);
    console.log(chalk.gray(`  ${ws.count} / ${ws.quota} sessions\n`));

    // ── Weekly token window ──────────────────────────────────────────────────
    const localWeeklyPct = sessions.weeklyTokens.statsCacheAllPercent;
    const effectiveWeeklyPct = Math.max(sessions.weeklyTokens.allPercent, localWeeklyPct);
    const scopeNote = localWeeklyPct > sessions.weeklyTokens.allPercent
      ? chalk.yellow(` · JSONL total: ${(localWeeklyPct * 100).toFixed(1)}% (higher — throttle uses this)`)
      : chalk.gray(` · JSONL total: ${(localWeeklyPct * 100).toFixed(1)}%`);
    console.log(chalk.bold('  All models (this week)') + scopeNote);
    console.log(`  ${bar(effectiveWeeklyPct)}  ${pctLabel(effectiveWeeklyPct)}`);
    console.log(chalk.gray(`  ${fmtTokens(quota.allTokens)} / ${fmtTokens(quota.allLimitTokens)} tokens (bridge DB)  ·  ${fmtTokens(sessions.weeklyTokens.statsCacheAllTokens)} (JSONL all sessions)\n`));

    console.log(chalk.bold('  Sonnet (this week)'));
    console.log(`  ${bar(quota.sonnetPercent)}  ${pctLabel(quota.sonnetPercent)}`);
    console.log(chalk.gray(`  ${fmtTokens(quota.sonnetTokens)} / ${fmtTokens(quota.sonnetLimitTokens)} tokens\n`));

    const planLimits = CLAUDE_PLAN_LIMITS[config.plan];
    console.log(chalk.gray(`  Plan limits: all=${fmtTokens(planLimits.weeklyAll)}/wk  sonnet=${fmtTokens(planLimits.weeklySonnet)}/wk`));
    console.log(chalk.gray('  Adjust plan: agent-scheduler init  (or edit ~/.agent-scheduler.json)\n'));
  });

usageCmd
  .command('quota-json')
  .description('Output current session and weekly quota as JSON (for scripting/throttle checks)')
  .action(() => {
    const config = loadConfig();
    const db = openDb(config.dbPath);
    const sessions = db.getSessionStats(config.plan);
    db.close();

    // Max policy (Option 2): conservative throttle signal = max(DB metric, stats-cache metric).
    // DB metric: Paperclip bridge sessions only.
    // stats-cache metric: ALL Claude Code sessions including board direct terminal/IDE usage.
    // Using max() ensures the board's direct usage is never ignored.
    const dbWeeklyPct = Math.round(sessions.weeklyTokens.allPercent * 100 * 10) / 10;
    const localWeeklyPct = Math.round(sessions.weeklyTokens.statsCacheAllPercent * 100 * 10) / 10;
    const weeklyAllPct = Math.max(dbWeeklyPct, localWeeklyPct);

    // currentSessionPct: today's JSONL token total vs per-session limit (0-100).
    //   Matches `claude /usage` "Current session" semantics. 0 when no JSONL activity today.
    // weeklyAllPct: MAX of DB (bridge-only) and JSONL (all board sessions).
    //   Use this as the authoritative throttle signal for subscription utilization.
    // weeklyAllPct_db: agent-scheduler SQL DB only (Paperclip bridge sessions). May be 0 if DB
    //   is not populated this week (board sessions routed directly, not through the bridge).
    // weeklyAllPct_local: JSONL aggregate — all Claude Code sessions including board direct.
    console.log(JSON.stringify({
      currentSessionPct: Math.round(sessions.currentSession.percent * 100 * 10) / 10,
      weeklySessionsPct: Math.round(sessions.weeklySessions.percent * 100 * 10) / 10,
      weeklyAllPct,
      weeklyAllPct_db: dbWeeklyPct,
      weeklyAllPct_local: localWeeklyPct,
      weeklyAllTokens: sessions.weeklyTokens.statsCacheAllTokens,
      weeklyAllLimitTokens: sessions.weeklyTokens.allLimitTokens,
      minutesUntilReset: sessions.currentSession.minutesUntilReset,
      weeklySessions: sessions.weeklySessions.count,
      weeklySessionQuota: sessions.weeklySessions.quota,
    }));
  });

// ─── usage breakdown ──────────────────────────────────────────────────────────
usageCmd
  .command('breakdown')
  .description('Show per-model token breakdown (input/output/cache) — claude /usage style detail')
  .option('--session', 'Scope to today (current 5-hour session window)', false)
  .option('--weekly', 'Scope to current Mon-anchored week (default)', false)
  .option('--monthly', 'Scope to last 30 days', false)
  .option('--json', 'Output as JSON', false)
  .action((opts: { session: boolean; weekly: boolean; monthly: boolean; json: boolean }) => {
    const config = loadConfig();
    const db = openDb(config.dbPath);

    // Determine time window
    const now = new Date();
    let from: Date;
    let to: Date = new Date(now.getTime() + 1000); // inclusive upper bound
    let periodLabel: string;

    if (opts.session) {
      // Today UTC
      from = new Date(now.toISOString().slice(0, 10) + 'T00:00:00.000Z');
      periodLabel = `today (${from.toISOString().slice(0, 10)} UTC)`;
    } else if (opts.monthly) {
      from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      periodLabel = 'last 30 days';
    } else {
      // Weekly (default): current Monday-anchored week
      const day = now.getUTCDay(); // 0=Sun
      const daysFromMonday = (day + 6) % 7;
      from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysFromMonday));
      to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
      periodLabel = `week ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`;
    }

    const rows = db.getModelBreakdown(from, to);
    db.close();

    if (opts.json) {
      console.log(JSON.stringify({ period: periodLabel, models: rows }, null, 2));
      return;
    }

    function fmtTok(n: number): string {
      if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
      if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
      return String(n);
    }

    console.log(chalk.bold.cyan('\n  agent-scheduler usage breakdown\n'));
    console.log(chalk.gray(`  Period: ${periodLabel}\n`));

    if (rows.length === 0) {
      console.log(chalk.gray('  No usage records in this period.\n'));
      return;
    }

    const COL = { model: 30, input: 10, output: 10, cacheR: 10, cacheW: 10, total: 10, cost: 12 };
    const header = [
      'Model'.padEnd(COL.model),
      'Input'.padEnd(COL.input),
      'Output'.padEnd(COL.output),
      'CacheRead'.padEnd(COL.cacheR),
      'CacheWrite'.padEnd(COL.cacheW),
      'Total'.padEnd(COL.total),
      'Cost USD',
    ];
    console.log(chalk.gray('  ' + header.join('  ')));
    console.log(chalk.gray('  ' + '─'.repeat(header.join('  ').length)));

    let totIn = 0, totOut = 0, totCR = 0, totCW = 0, totAll = 0, totCost = 0;
    for (const r of rows) {
      totIn += r.inputTokens; totOut += r.outputTokens;
      totCR += r.cacheReadTokens; totCW += r.cacheWriteTokens;
      totAll += r.totalTokens; totCost += r.costUsd;
      console.log(
        '  ' + [
          r.model.slice(0, COL.model - 1).padEnd(COL.model),
          fmtTok(r.inputTokens).padEnd(COL.input),
          fmtTok(r.outputTokens).padEnd(COL.output),
          fmtTok(r.cacheReadTokens).padEnd(COL.cacheR),
          fmtTok(r.cacheWriteTokens).padEnd(COL.cacheW),
          fmtTok(r.totalTokens).padEnd(COL.total),
          '$' + r.costUsd.toFixed(4),
        ].join('  ')
      );
    }

    // Totals row
    console.log(chalk.gray('  ' + '─'.repeat(header.join('  ').length)));
    console.log(
      chalk.bold('  ' + [
        'TOTAL'.padEnd(COL.model),
        fmtTok(totIn).padEnd(COL.input),
        fmtTok(totOut).padEnd(COL.output),
        fmtTok(totCR).padEnd(COL.cacheR),
        fmtTok(totCW).padEnd(COL.cacheW),
        fmtTok(totAll).padEnd(COL.total),
        '$' + totCost.toFixed(4),
      ].join('  '))
    );
    console.log();
  });

usageCmd
  .command('list')
  .description('List usage records')
  .option('--provider <provider>', 'Filter by provider (anthropic|openai|gemini)')
  .option('--limit <limit>', 'Max records to show', '20')
  .action((opts: { provider?: string; limit: string }) => {
    const config = loadConfig();
    const db = openDb(config.dbPath);
    const records = db.listUsage({
      limit: parseInt(opts.limit, 10),
      provider: opts.provider,
    });
    db.close();

    if (records.length === 0) {
      console.log(chalk.gray('\n  No usage records found.\n'));
      return;
    }

    console.log(chalk.bold.cyan('\n  Usage records:\n'));
    const header = ['Time'.padEnd(20), 'Model'.padEnd(28), 'In'.padEnd(8), 'Out'.padEnd(8), 'CacheR'.padEnd(10), 'CacheW'.padEnd(10), 'Cost USD'];
    console.log(chalk.gray('  ' + header.join('  ')));
    console.log(chalk.gray('  ' + '─'.repeat(100)));

    for (const r of records) {
      const ts = r.timestamp.toISOString().replace('T', ' ').slice(0, 19);
      console.log(
        '  ' + [
          ts.padEnd(20),
          r.model.padEnd(28),
          String(r.inputTokens).padEnd(8),
          String(r.outputTokens).padEnd(8),
          String(r.cacheReadTokens).padEnd(10),
          String(r.cacheWriteTokens).padEnd(10),
          '$' + r.costUsd.toFixed(6),
        ].join('  ')
      );
    }
    console.log();
  });

// ─── check-budget ────────────────────────────────────────────────────────────
program
  .command('check-budget')
  .description('Exit non-zero if token quota or any blocking $ budget is exceeded (used by Paperclip hook)')
  .option('--agent-id <agentId>', 'Agent ID to scope the check (informational)')
  .option('--skip-quota', 'Skip token quota check (use $ budget only)', false)
  .action((opts: { agentId?: string; skipQuota: boolean }) => {
    const config = loadConfig();
    const db = openDb(config.dbPath);

    let exceeded = false;

    // ── Primary: token quota % check ─────────────────────────────────────────
    if (!opts.skipQuota) {
      const quota = db.getTokenQuotaStatus(config.plan);
      if (quota.allPercent >= 1.0) {
        const pct = (quota.allPercent * 100).toFixed(1);
        console.error(
          chalk.red(`  ✗ Token quota exceeded: ${pct}% of weekly ${quota.plan} all-model limit (${quota.allLimitTokens.toLocaleString()} tokens)`)
        );
        exceeded = true;
      } else if (quota.allPercent >= 0.8) {
        const pct = (quota.allPercent * 100).toFixed(1);
        console.error(
          chalk.yellow(`  ⚠ Token quota warning: ${pct}% of weekly ${quota.plan} all-model limit`)
        );
      }
    }

    // ── Secondary: $ budget block check (kept for backwards-compat) ──────────
    const budgets = db.listBudgets();
    const blocking = budgets.filter(b => b.action === 'block');
    for (const budget of blocking) {
      const status = db.getBudgetStatus(budget);
      if (status.usagePercent >= 1) {
        const pct = (status.usagePercent * 100).toFixed(1);
        console.error(
          chalk.red(`  ✗ $ Budget '${budget.name}' exceeded: ${pct}% of $${budget.limitUsd}/${budget.period}`)
        );
        exceeded = true;
      }
    }

    db.close();
    if (exceeded) {
      if (opts.agentId) {
        console.error(chalk.red(`  Agent ${opts.agentId} is over limit. Blocking heartbeat.`));
      }
      process.exit(1);
    }
    process.exit(0);
  });

// ─── sync ─────────────────────────────────────────────────────────────────────
program
  .command('sync')
  .description('Sync usage data from external sources into the local DB')
  .argument('[source]', 'Source to sync from: claude-code', 'claude-code')
  .option('--projects-dir <dir>', 'Claude Code projects directory',
    join(homedir(), '.claude', 'projects'))
  .option('--dry-run', 'Print records without writing them', false)
  .action(async (source: string, opts: { projectsDir: string; dryRun: boolean }) => {
    if (source !== 'claude-code') {
      console.error(chalk.red(`  Unknown source '${source}'. Supported: claude-code`));
      process.exit(1);
    }

    const config = loadConfig();
    const db = opts.dryRun ? null : openDb(config.dbPath);

    // Collect all .jsonl files recursively under projects dir
    const jsonlFiles: string[] = [];
    function collectJsonl(dir: string): void {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const entry of entries) {
        const full = join(dir, entry);
        try {
          const st = statSync(full);
          if (st.isDirectory()) {
            collectJsonl(full);
          } else if (entry.endsWith('.jsonl')) {
            jsonlFiles.push(full);
          }
        } catch { /* skip unreadable */ }
      }
    }
    collectJsonl(opts.projectsDir);

    console.log(chalk.bold.cyan('\n  agent-scheduler sync claude-code\n'));
    console.log(chalk.gray(`  Projects dir: ${opts.projectsDir}`));
    console.log(chalk.gray(`  JSONL files:  ${jsonlFiles.length}`));
    if (opts.dryRun) console.log(chalk.yellow('  DRY RUN — no writes\n'));
    else console.log();

    let totalInserted = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (const file of jsonlFiles) {
      await new Promise<void>((resolve) => {
        const rl = createLineInterface({ input: createReadStream(file), crlfDelay: Infinity });
        rl.on('line', (line) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          let entry: any;
          try { entry = JSON.parse(trimmed); } catch { totalErrors++; return; }

          // Only assistant messages with usage data
          const msg = entry.message;
          if (!msg || msg.role !== 'assistant' || !msg.usage) return;
          const sourceId: string | undefined = msg.id;
          if (!sourceId) return;

          const model: string = msg.model ?? 'unknown';
          const usage = msg.usage as {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          const inputTokens = usage.input_tokens ?? 0;
          const outputTokens = usage.output_tokens ?? 0;
          const cacheRead = usage.cache_read_input_tokens ?? 0;
          const cacheWrite = usage.cache_creation_input_tokens ?? 0;
          const costUsd = calcCostUsdWithCache(model, inputTokens, outputTokens, cacheRead, cacheWrite);

          const timestamp = entry.timestamp ? new Date(entry.timestamp as string) : new Date();

          if (opts.dryRun) {
            const ts = timestamp.toISOString().replace('T', ' ').slice(0, 19);
            console.log(chalk.gray(`  [dry] ${ts}  ${model.padEnd(24)}  in=${inputTokens}  out=${outputTokens}  $${costUsd.toFixed(6)}`));
            totalInserted++;
            return;
          }

          const result = db!.insertUsageFromSource(
            {
              provider: 'anthropic', model, inputTokens, outputTokens,
              cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
              costUsd, timestamp,
              metadata: { sessionId: entry.sessionId, sourceFile: file },
            },
            sourceId,
          );
          if (result.inserted) totalInserted++;
          else totalSkipped++;
        });
        rl.on('close', resolve);
        rl.on('error', () => { totalErrors++; resolve(); });
      });
    }

    db?.close();

    console.log(chalk.bold('\n  Results:'));
    console.log(chalk.green(`  ✓ Inserted: ${totalInserted}`));
    console.log(chalk.gray(`  – Skipped (already synced): ${totalSkipped}`));
    if (totalErrors > 0) console.log(chalk.yellow(`  ⚠ Parse errors: ${totalErrors}`));
    console.log();
  });

// ─── report ───────────────────────────────────────────────────────────────────
program
  .command('report')
  .description('Human-readable spend report with daily breakdown and model summary')
  .option('--period <period>', 'daily | weekly | monthly  (default: weekly)', 'weekly')
  .option('--days <days>', 'Custom number of days to cover (overrides --period)')
  .option('--plain', 'Output plain text without ANSI colors (for email)', false)
  .action((opts: { period: string; days?: string; plain: boolean }) => {
    const config = loadConfig();
    const db = openDb(config.dbPath);

    const now = new Date();
    let periodStart: Date;
    let periodLabel: string;

    if (opts.days != null) {
      const n = parseInt(opts.days, 10);
      periodStart = new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
      periodLabel = `last ${n} days`;
    } else if (opts.period === 'daily') {
      periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      periodLabel = `today (${periodStart.toISOString().slice(0, 10)} UTC)`;
    } else if (opts.period === 'monthly') {
      periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      periodLabel = `this month (${periodStart.toISOString().slice(0, 7)})`;
    } else {
      // weekly — Monday-anchored current week (same as usage breakdown)
      const day = now.getUTCDay();
      const daysFromMonday = (day + 6) % 7;
      periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysFromMonday));
      const periodEnd = new Date(periodStart.getTime() + 7 * 24 * 60 * 60 * 1000);
      periodLabel = `week ${periodStart.toISOString().slice(0, 10)} → ${periodEnd.toISOString().slice(0, 10)}`;
    }

    const records = db.listUsage({ limit: 1_000_000 }).filter(r => r.timestamp >= periodStart);
    db.close();

    // ── Aggregate by model ───────────────────────────────────────────────────
    interface ModelStats {
      input: number; output: number; cacheRead: number; cacheWrite: number; cost: number;
    }
    const byModel = new Map<string, ModelStats>();
    let totalCost = 0;

    for (const r of records) {
      const acc = byModel.get(r.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      acc.input += r.inputTokens;
      acc.output += r.outputTokens;
      acc.cacheRead += r.cacheReadTokens;
      acc.cacheWrite += r.cacheWriteTokens;
      acc.cost += r.costUsd;
      byModel.set(r.model, acc);
      totalCost += r.costUsd;
    }

    // ── Aggregate by day (UTC date key YYYY-MM-DD) ───────────────────────────
    const byDay = new Map<string, number>();
    for (const r of records) {
      const day = r.timestamp.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + r.costUsd);
    }
    const sortedDays = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    // ── Display helpers ──────────────────────────────────────────────────────
    const c = opts.plain
      ? { bold: (s: string) => s, cyan: (s: string) => s, gray: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s, red: (s: string) => s }
      : { bold: chalk.bold, cyan: chalk.bold.cyan, gray: chalk.gray, green: chalk.green, yellow: chalk.yellow, red: chalk.red };

    function pctColor(pct: number, text: string): string {
      if (opts.plain) return text;
      return pct >= 100 ? chalk.red(text) : pct >= 80 ? chalk.yellow(text) : chalk.green(text);
    }

    function spendBar(cost: number, maxCost: number, width = 24): string {
      if (maxCost === 0) return opts.plain ? '░'.repeat(width) : chalk.gray('░'.repeat(width));
      const filled = Math.min(Math.round((cost / maxCost) * width), width);
      const empty = width - filled;
      const bar = '█'.repeat(filled) + '░'.repeat(empty);
      return opts.plain ? bar : chalk.cyan(bar);
    }

    // ── Render ───────────────────────────────────────────────────────────────
    console.log(c.cyan('\n  agent-scheduler report\n'));
    console.log(`  ${c.bold('Period')}     ${periodLabel}`);
    console.log(`  ${c.bold('Records')}    ${records.length.toLocaleString()}`);
    console.log(c.bold(`  Total       $${totalCost.toFixed(4)}\n`));
    console.log(c.gray(`  ${'─'.repeat(52)}`));

    // Day-by-day spend
    if (sortedDays.length > 0) {
      console.log(c.bold('\n  By day:\n'));
      const maxDay = Math.max(...sortedDays.map(([, v]) => v));
      for (const [day, cost] of sortedDays) {
        const pct = totalCost > 0 ? (cost / totalCost) * 100 : 0;
        const bar = spendBar(cost, maxDay);
        const costStr = `$${cost.toFixed(4)}`.padStart(10);
        const pctStr = `(${pct.toFixed(0)}%)`.padStart(6);
        console.log(`  ${c.gray(day)}  ${bar}  ${costStr}  ${c.gray(pctStr)}`);
      }
    } else {
      console.log(c.gray('\n  No records in this period.'));
    }

    // By model
    if (byModel.size > 0) {
      console.log(c.bold('\n  By model:\n'));
      const maxModelCost = Math.max(...[...byModel.values()].map(m => m.cost));
      for (const [model, m] of [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
        const totalTok = m.input + m.output + m.cacheRead + m.cacheWrite;
        const pct = totalCost > 0 ? (m.cost / totalCost) * 100 : 0;
        const bar = spendBar(m.cost, maxModelCost);
        const shortModel = model.length > 28 ? model.slice(0, 28) + '…' : model.padEnd(29);
        console.log(`  ${c.gray(shortModel)}  ${bar}  $${m.cost.toFixed(4)}  ${c.gray(`(${pct.toFixed(0)}%)  ${totalTok.toLocaleString()} tok`)}`);
      }
    }

    console.log();
  });

program.parse();
