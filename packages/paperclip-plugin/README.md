# @agent-scheduler/paperclip-plugin

Paperclip plugin that gates agent heartbeats based on AI API budgets configured via agent-scheduler.

## How it works

Registers an `agent:heartbeat:before` hook that runs `agent-scheduler check-budget` before each heartbeat. If any blocking budget is exceeded, the heartbeat is cancelled.

## Setup

1. Install the CLI globally: `npm install -g @agent-scheduler/cli`
2. Configure a blocking budget: `agent-scheduler budget set default 10 --period monthly --action block`
3. Install this plugin in your Paperclip workspace

## Skills

- **budget-status** — Check current usage and budget status from within an agent

## Documentation

See the [Paperclip integration guide](../../docs/paperclip-integration.md).
