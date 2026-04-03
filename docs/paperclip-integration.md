# Paperclip Integration Guide

agent-scheduler ships a first-class Paperclip plugin (`packages/paperclip-plugin`) that gates agent heartbeats based on your configured budgets.

## How it works

The plugin registers an `agent:heartbeat:before` hook. Before each heartbeat fires, Paperclip runs:

```bash
agent-scheduler check-budget --agent-id $PAPERCLIP_AGENT_ID
```

- Exit `0` → heartbeat proceeds as normal
- Exit `1` → heartbeat is cancelled; the agent stays paused until budget resets

This means agents stop incurring costs automatically when they hit their monthly limit.

## Setup

### 1. Install agent-scheduler globally

```bash
npm install -g @agent-scheduler/cli
```

### 2. Initialize and configure a blocking budget

```bash
agent-scheduler init
agent-scheduler budget set default 10 --period monthly --action block
```

### 3. Install the Paperclip plugin

```bash
paperclipai skill install @agent-scheduler/paperclip-plugin
```

Or from source in a local project, add to your Paperclip project workspace and run:

```bash
paperclipai skills scan-projects
```

### 4. Verify

Trigger a heartbeat and confirm the hook runs:

```bash
paperclipai heartbeat run --agent-id <your-agent-id>
```

The run log should show the `agent:heartbeat:before` hook executing successfully (exit 0).

## Budget actions

| Action | Heartbeat behaviour |
|--------|---------------------|
| `alert` | Heartbeat proceeds; a warning is logged |
| `block` | Heartbeat cancelled when budget is at 100% |
| `queue` | (future) Heartbeat deferred until next period |

## Tracking usage in agent code

If your agent makes direct Anthropic SDK calls, wrap the client to auto-track usage:

```typescript
import { wrapAnthropic } from '@agent-scheduler/core';
import Anthropic from '@anthropic-ai/sdk';

const client = wrapAnthropic(new Anthropic(), {
  agentId: process.env.PAPERCLIP_AGENT_ID,
  taskId: process.env.PAPERCLIP_TASK_ID,
});
```

All calls through the wrapped client are recorded in the local DB and counted against configured budgets.

## Checking budget manually

Within any agent heartbeat, you can invoke the `budget-status` skill:

```bash
agent-scheduler status
```

Or use the skill directly (if your agent has the `budget-status` skill installed via Paperclip):

> See the [budget-status skill](../packages/paperclip-plugin/skills/budget-status.md) for details.
