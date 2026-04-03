import { useEffect, useState } from 'react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

interface Summary {
  daily: { date: string; cost: number }[];
  byProvider: { provider: string; cost: number }[];
  todayCost: number;
  monthCost: number;
  totalRecords: number;
}

interface BudgetWithStatus {
  id: string;
  name: string;
  limitUsd: number;
  period: string;
  alertThreshold: number;
  action: string;
  status: {
    spentUsd: number;
    remainingUsd: number;
    usagePercent: number;
  };
}

interface UsageRecord {
  id: string;
  timestamp: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: '#8b5cf6',
  openai: '#10b981',
  gemini: '#3b82f6',
};

function BudgetCard({ b }: { b: BudgetWithStatus }) {
  const pct = Math.min(b.status.usagePercent * 100, 100);
  const color =
    pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-400' : 'bg-emerald-500';
  const textColor =
    pct >= 100 ? 'text-red-500' : pct >= 80 ? 'text-yellow-500' : 'text-emerald-500';

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
      <div className="flex justify-between items-start mb-3">
        <div>
          <p className="font-semibold text-gray-800">{b.name}</p>
          <p className="text-xs text-gray-400 mt-0.5">{b.period} · action: {b.action}</p>
        </div>
        <span className={`text-lg font-bold ${textColor}`}>{pct.toFixed(1)}%</span>
      </div>
      <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-xs text-gray-400 mt-2">
        <span>${b.status.spentUsd.toFixed(4)} spent</span>
        <span>${b.limitUsd} limit</span>
      </div>
    </div>
  );
}

export default function App() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [budgets, setBudgets] = useState<BudgetWithStatus[]>([]);
  const [usage, setUsage] = useState<UsageRecord[]>([]);

  useEffect(() => {
    async function load() {
      const [s, b, u] = await Promise.all([
        fetch('/api/summary').then(r => r.json()),
        fetch('/api/budgets').then(r => r.json()),
        fetch('/api/usage?limit=20').then(r => r.json()),
      ]);
      setSummary(s);
      setBudgets(b);
      setUsage(u);
    }
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  if (!summary) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50 text-gray-400">
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Agent Scheduler</h1>
          <p className="text-sm text-gray-500 mt-1">AI API usage monitoring</p>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <p className="text-xs text-gray-400 uppercase tracking-wide">Today</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">${summary.todayCost.toFixed(4)}</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <p className="text-xs text-gray-400 uppercase tracking-wide">This Month</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">${summary.monthCost.toFixed(4)}</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <p className="text-xs text-gray-400 uppercase tracking-wide">Total Records</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{summary.totalRecords}</p>
          </div>
        </div>

        {/* Budget cards */}
        {budgets.length > 0 && (
          <div className="mb-6">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Budgets</h2>
            <div className="grid grid-cols-2 gap-4">
              {budgets.map(b => <BudgetCard key={b.id} b={b} />)}
            </div>
          </div>
        )}

        {/* Charts */}
        <div className="grid grid-cols-2 gap-4 mb-6">
          {/* Daily cost trend */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Daily Cost (last 30 days)</h2>
            {summary.daily.length === 0 ? (
              <p className="text-gray-400 text-sm text-center py-8">No data yet</p>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={summary.daily}>
                  <defs>
                    <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.15} />
                      <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} />
                  <YAxis tick={{ fontSize: 11 }} tickLine={false} tickFormatter={v => `$${v.toFixed(3)}`} />
                  <Tooltip formatter={(v: number) => [`$${v.toFixed(6)}`, 'Cost']} />
                  <Area type="monotone" dataKey="cost" stroke="#8b5cf6" strokeWidth={2} fill="url(#costGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* By provider */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Cost by Provider</h2>
            {summary.byProvider.length === 0 ? (
              <p className="text-gray-400 text-sm text-center py-8">No data yet</p>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={summary.byProvider}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="provider" tick={{ fontSize: 11 }} tickLine={false} />
                  <YAxis tick={{ fontSize: 11 }} tickLine={false} tickFormatter={v => `$${v.toFixed(3)}`} />
                  <Tooltip formatter={(v: number) => [`$${v.toFixed(6)}`, 'Cost']} />
                  <Bar dataKey="cost" radius={[4, 4, 0, 0]}>
                    {summary.byProvider.map((entry) => (
                      <rect key={entry.provider} fill={PROVIDER_COLORS[entry.provider] ?? '#6b7280'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Recent usage table */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-700">Recent Usage</h2>
          </div>
          {usage.length === 0 ? (
            <p className="text-gray-400 text-sm text-center py-10">No usage records yet</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-400 uppercase tracking-wide bg-gray-50">
                  <th className="px-5 py-3 text-left font-medium">Time</th>
                  <th className="px-5 py-3 text-left font-medium">Provider</th>
                  <th className="px-5 py-3 text-left font-medium">Model</th>
                  <th className="px-5 py-3 text-right font-medium">Input</th>
                  <th className="px-5 py-3 text-right font-medium">Output</th>
                  <th className="px-5 py-3 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {usage.map(r => (
                  <tr key={r.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-5 py-3 text-gray-500 text-xs">
                      {new Date(r.timestamp).toISOString().replace('T', ' ').slice(0, 19)}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium text-white"
                        style={{ background: PROVIDER_COLORS[r.provider] ?? '#6b7280' }}
                      >
                        {r.provider}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-gray-700 font-mono text-xs">{r.model}</td>
                    <td className="px-5 py-3 text-right text-gray-500">{r.inputTokens.toLocaleString()}</td>
                    <td className="px-5 py-3 text-right text-gray-500">{r.outputTokens.toLocaleString()}</td>
                    <td className="px-5 py-3 text-right font-medium text-gray-800">${r.costUsd.toFixed(6)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
