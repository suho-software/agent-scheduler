#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { createInterface } from 'node:readline/promises';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface as createLineInterface } from 'node:readline';
import { openDb, calcCostUsdWithCache } from '@agent-scheduler/core';

const CONFIG_PATH = join(homedir(), '.agent-scheduler.json');

interface Config {
  dbPath: string;
  defaultBudgetUsd: number;
}

function loadConfig(): Config {
  if (existsSync(CONFIG_PATH)) {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Config;
  }
  return { dbPath: join(homedir(), '.agent-scheduler.db'), defaultBudgetUsd: 10 };
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
    rl.close();

    const config: Config = {
      dbPath: dbPath.trim() || existing.dbPath,
      defaultBudgetUsd: budgetStr.trim() ? parseFloat(budgetStr) : existing.defaultBudgetUsd,
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
    console.log(chalk.gray(`    Budget: $${config.defaultBudgetUsd}/month\n`));
  });

// ─── status ──────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show today / this-month usage and budget status')
  .action(() => {
    const config = loadConfig();
    const db = openDb(config.dbPath);
    const budgets = db.listBudgets();
    const usage = db.listUsage({ limit: 10000 });
    db.close();

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const todayCost = usage
      .filter(r => r.timestamp.toISOString().slice(0, 10) === todayStr)
      .reduce((s, r) => s + r.costUsd, 0);
    const monthCost = usage
      .filter(r =>
        r.timestamp.getFullYear() === today.getFullYear() &&
        r.timestamp.getMonth() === today.getMonth()
      )
      .reduce((s, r) => s + r.costUsd, 0);

    console.log(chalk.bold.cyan('\n  agent-scheduler status\n'));
    console.log(`  ${chalk.bold('Today')}       $${todayCost.toFixed(4)}`);
    console.log(`  ${chalk.bold('This month')} $${monthCost.toFixed(4)}`);
    console.log(`  ${chalk.bold('Records')}    ${usage.length}`);

    if (budgets.length > 0) {
      console.log(chalk.bold('\n  Budgets:\n'));
      for (const budget of budgets) {
        const pct = budget.limitUsd > 0 ? (monthCost / budget.limitUsd) * 100 : 0;
        const bar = buildBar(pct);
        const color = pct >= 100 ? chalk.red : pct >= 80 ? chalk.yellow : chalk.green;
        console.log(`  ${chalk.bold(budget.name)} (${budget.period})`);
        console.log(`    ${bar} ${color(pct.toFixed(1) + '%')} of $${budget.limitUsd}`);
      }
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

// ─── usage ───────────────────────────────────────────────────────────────────
const usageCmd = program
  .command('usage')
  .description('Usage record commands');

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
    const header = ['Time'.padEnd(20), 'Provider'.padEnd(12), 'Model'.padEnd(24), 'In'.padEnd(8), 'Out'.padEnd(8), 'Cost USD'];
    console.log(chalk.gray('  ' + header.join('  ')));
    console.log(chalk.gray('  ' + '─'.repeat(85)));

    for (const r of records) {
      const ts = r.timestamp.toISOString().replace('T', ' ').slice(0, 19);
      console.log(
        '  ' + [
          ts.padEnd(20),
          r.provider.padEnd(12),
          r.model.padEnd(24),
          String(r.inputTokens).padEnd(8),
          String(r.outputTokens).padEnd(8),
          '$' + r.costUsd.toFixed(6),
        ].join('  ')
      );
    }
    console.log();
  });

// ─── check-budget ────────────────────────────────────────────────────────────
program
  .command('check-budget')
  .description('Exit non-zero if any blocking budget is exceeded (used by Paperclip hook)')
  .option('--agent-id <agentId>', 'Agent ID to scope the check (informational)')
  .action((opts: { agentId?: string }) => {
    const config = loadConfig();
    const db = openDb(config.dbPath);
    const budgets = db.listBudgets();

    const blocking = budgets.filter(b => b.action === 'block');
    if (blocking.length === 0) {
      db.close();
      process.exit(0);
    }

    let exceeded = false;
    for (const budget of blocking) {
      const status = db.getBudgetStatus(budget);
      if (status.usagePercent >= 1) {
        const pct = (status.usagePercent * 100).toFixed(1);
        console.error(
          chalk.red(`  ✗ Budget '${budget.name}' exceeded: ${pct}% of $${budget.limitUsd}/${budget.period}`)
        );
        exceeded = true;
      }
    }

    db.close();
    if (exceeded) {
      if (opts.agentId) {
        console.error(chalk.red(`  Agent ${opts.agentId} is over budget. Blocking heartbeat.`));
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
            { provider: 'anthropic', model, inputTokens, outputTokens, costUsd, timestamp,
              metadata: { cacheRead, cacheWrite, sessionId: entry.sessionId, sourceFile: file } },
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

program.parse();
