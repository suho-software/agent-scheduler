import express from 'express';
import { openDb } from '@agent-scheduler/core';
import { readFileSync, existsSync } from 'node:fs';
import { join, homedir } from 'node:path';

const CONFIG_PATH = join(homedir(), '.agent-scheduler.json');

function loadConfig() {
  if (existsSync(CONFIG_PATH)) {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  }
  return { dbPath: join(homedir(), '.agent-scheduler.db') };
}

const app = express();
const config = loadConfig();
const db = openDb(config.dbPath);

app.get('/api/usage', (req, res) => {
  const limit = parseInt(req.query.limit ?? '500', 10);
  const provider = req.query.provider;
  const records = db.listUsage({ limit, provider });
  res.json(records);
});

app.get('/api/budgets', (_req, res) => {
  const budgets = db.listBudgets();
  const result = budgets.map((b) => ({
    ...b,
    status: db.getBudgetStatus(b),
  }));
  res.json(result);
});

app.get('/api/summary', (_req, res) => {
  const usage = db.listUsage({ limit: 10000 });
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  const dailyMap = {};
  for (const r of usage) {
    const day = r.timestamp.toISOString().slice(0, 10);
    dailyMap[day] = (dailyMap[day] ?? 0) + r.costUsd;
  }

  const providerMap = {};
  for (const r of usage) {
    providerMap[r.provider] = (providerMap[r.provider] ?? 0) + r.costUsd;
  }

  const daily = Object.entries(dailyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-30)
    .map(([date, cost]) => ({ date, cost }));

  const byProvider = Object.entries(providerMap).map(([provider, cost]) => ({
    provider,
    cost,
  }));

  const todayCost = usage
    .filter((r) => r.timestamp.toISOString().slice(0, 10) === todayStr)
    .reduce((s, r) => s + r.costUsd, 0);

  const monthCost = usage
    .filter(
      (r) =>
        r.timestamp.getFullYear() === today.getFullYear() &&
        r.timestamp.getMonth() === today.getMonth()
    )
    .reduce((s, r) => s + r.costUsd, 0);

  res.json({ daily, byProvider, todayCost, monthCost, totalRecords: usage.length });
});

const PORT = 3737;
app.listen(PORT, () => {
  console.log(`[agent-scheduler] API server running on http://localhost:${PORT}`);
});
