# @agent-scheduler/cli

CLI for tracking AI API usage and enforcing budget limits.

## Install

```bash
npm install -g @agent-scheduler/cli
```

## Commands

```bash
agent-scheduler init                    # Interactive setup
agent-scheduler status                  # Show usage and budget progress
agent-scheduler check-budget            # Exit 1 if any blocking budget is exceeded
agent-scheduler budget set <n> <usd>   # Create/update a budget
agent-scheduler budget list             # List all budgets
agent-scheduler usage list              # Show recent usage records
```

## Quick start

```bash
agent-scheduler init
agent-scheduler budget set default 10 --period monthly --action block
agent-scheduler status
```

## Documentation

- [Installation guide](../../docs/installation.md)
- [Quick start](../../docs/quickstart.md)
- [Paperclip integration](../../docs/paperclip-integration.md)
- [Full API reference](../../docs/api-reference.md)
