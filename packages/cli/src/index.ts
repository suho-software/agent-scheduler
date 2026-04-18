#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { createInterface } from 'node:readline/promises';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface as createLineInterface } from 'node:readline';
import { openDb, calcCostUsdWithCache, CLAUDE_PLAN_LIMITS, ClaudePlan } from '@agent-scheduler/core';

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

    // ── Current session (today from stats-cache.json) ────────────────────────
    const cs = sessions.currentSession;
    const sourceNote = cs.fromStatsCache ? chalk.gray(' · via stats-cache.json') : chalk.yellow(' · stats-cache has no data for today');
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
    console.log(chalk.bold('  All models (this week)'));
    console.log(`  ${bar(quota.allPercent)}  ${pctLabel(quota.allPercent)}`);
    console.log(chalk.gray(`  ${fmtTokens(quota.allTokens)} / ${fmtTokens(quota.allLimitTokens)} tokens\n`));

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

    // currentSessionPct: from stats-cache.json today's tokens vs session limit (0-100).
    //   Matches `claude /usage` "Current session" semantics. 0 when no stats-cache entry for today.
    // weeklyAllPct: weekly all-model token quota from DB (0-100).
    //   Use this as the authoritative throttle signal for subscription utilization.
    console.log(JSON.stringify({
      currentSessionPct: Math.round(sessions.currentSession.percent * 100 * 10) / 10,
      weeklySessionsPct: Math.round(sessions.weeklySessions.percent * 100 * 10) / 10,
      weeklyAllPct: Math.round(sessions.weeklyTokens.allPercent * 100 * 10) / 10,
      weeklyAllTokens: sessions.weeklyTokens.allTokens,
      weeklyAllLimitTokens: sessions.weeklyTokens.allLimitTokens,
      minutesUntilReset: sessions.currentSession.minutesUntilReset,
      weeklySessions: sessions.weeklySessions.count,
      weeklySessionQuota: sessions.weeklySessions.quota,
    }));
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
  .description('Show weekly usage report with percentage bars (like claude /usage)')
  .option('--days <days>', 'Number of days to cover (default 7)', '7')
  .option('--weekly-limit <tokens>', 'Weekly token limit to measure against (default: Claude Max 5x ≈ 288000000)')
  .option('--sonnet-limit <tokens>', 'Sonnet-specific weekly token limit (default: 1008000000)')
  .option('--plain', 'Output plain text without ANSI colors (for email)', false)
  .action((opts: { days: string; weeklyLimit?: string; sonnetLimit?: string; plain: boolean }) => {
    const config = loadConfig();
    const db = openDb(config.dbPath);

    const days = parseInt(opts.days, 10);
    // Defaults back-calculated from Claude Max 5x plan observed via /usage:
    // all models 84% = 242M → limit ≈ 288M; Sonnet 24% = 242M → limit ≈ 1B
    const weeklyLimitAll = parseInt(opts.weeklyLimit ?? '288000000', 10);
    const weeklyLimitSonnet = parseInt(opts.sonnetLimit ?? '1008000000', 10);

    const now = new Date();
    const periodStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    // Get all records with metadata for the period
    const rows = (db as any)['db'].prepare(
      `SELECT model, input_tokens, output_tokens, cost_usd, metadata, timestamp
       FROM usage_records WHERE timestamp >= ? ORDER BY timestamp ASC`
    ).all(periodStart.toISOString()) as Array<{
      model: string; input_tokens: number; output_tokens: number;
      cost_usd: number; metadata: string | null; timestamp: string;
    }>;

    db.close();

    // Aggregate total tokens (including cache) per model
    interface ModelStats {
      input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; count: number;
    }
    const byModel = new Map<string, ModelStats>();
    let totalCost = 0;

    for (const r of rows) {
      const meta = r.metadata ? JSON.parse(r.metadata) as { cacheRead?: number; cacheWrite?: number } : {};
      const total: ModelStats = byModel.get(r.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, count: 0 };
      total.input += r.input_tokens;
      total.output += r.output_tokens;
      total.cacheRead += meta.cacheRead ?? 0;
      total.cacheWrite += meta.cacheWrite ?? 0;
      total.cost += r.cost_usd;
      total.count += 1;
      byModel.set(r.model, total);
      totalCost += r.cost_usd;
    }

    const allTotal = [...byModel.values()].reduce(
      (s, m) => ({ tokens: s.tokens + m.input + m.output + m.cacheRead + m.cacheWrite }), { tokens: 0 }
    ).tokens;

    const sonnetTotal = [...byModel.entries()]
      .filter(([k]) => k.toLowerCase().includes('sonnet'))
      .reduce((s, [, m]) => s + m.input + m.output + m.cacheRead + m.cacheWrite, 0);

    const pctAll = weeklyLimitAll > 0 ? (allTotal / weeklyLimitAll) * 100 : 0;
    const pctSonnet = weeklyLimitSonnet > 0 ? (sonnetTotal / weeklyLimitSonnet) * 100 : 0;

    const barWidth = 40;
    function bar(pct: number): string {
      const filled = Math.min(Math.round((pct / 100) * barWidth), barWidth);
      const empty = barWidth - filled;
      if (opts.plain) return '█'.repeat(filled) + '░'.repeat(empty);
      const color = pct >= 100 ? chalk.red : pct >= 80 ? chalk.yellow : chalk.green;
      return color('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
    }

    function pctColor(pct: number, text: string): string {
      if (opts.plain) return text;
      return pct >= 100 ? chalk.red(text) : pct >= 80 ? chalk.yellow(text) : chalk.green(text);
    }

    const label = opts.plain ? '' : chalk.bold.cyan;
    const gray = opts.plain ? (s: string) => s : chalk.gray;

    if (!opts.plain) console.log(chalk.bold.cyan('\n  agent-scheduler report\n'));
    else console.log('\n  agent-scheduler report\n');

    console.log(`  ${opts.plain ? '' : chalk.bold('Period')}${opts.plain ? 'Period: ' : ''}     last ${days} days  (${periodStart.toISOString().slice(0,10)} → ${now.toISOString().slice(0,10)})`);
    console.log(`  ${opts.plain ? 'Records: ' : chalk.bold('Records')}    ${rows.length.toLocaleString()}`);
    console.log(`  ${opts.plain ? 'Cost USD: ' : chalk.bold('Cost USD')}   $${totalCost.toFixed(4)}\n`);

    console.log(`  ${opts.plain ? 'All models (7d):' : chalk.bold('All models (7d):')}  ${allTotal.toLocaleString()} tokens`);
    console.log(`  ${bar(pctAll)}  ${pctColor(pctAll, pctAll.toFixed(1) + '% used')}`);
    console.log(gray(`  Limit: ${weeklyLimitAll.toLocaleString()} tokens  (--weekly-limit to adjust)\n`));

    console.log(`  ${opts.plain ? 'Sonnet only (7d):' : chalk.bold('Sonnet only (7d):')} ${sonnetTotal.toLocaleString()} tokens`);
    console.log(`  ${bar(pctSonnet)}  ${pctColor(pctSonnet, pctSonnet.toFixed(1) + '% used')}`);
    console.log(gray(`  Limit: ${weeklyLimitSonnet.toLocaleString()} tokens  (--sonnet-limit to adjust)\n`));

    if (byModel.size > 0) {
      console.log(opts.plain ? '  By model:' : chalk.bold('  By model:'));
      for (const [model, m] of [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
        const t = m.input + m.output + m.cacheRead + m.cacheWrite;
        const shortModel = model.length > 30 ? model.slice(0, 30) + '…' : model;
        console.log(gray(`    ${shortModel.padEnd(32)} ${t.toLocaleString().padStart(12)} tokens   $${m.cost.toFixed(4)}`));
      }
      console.log();
    }
  });

program.parse();
