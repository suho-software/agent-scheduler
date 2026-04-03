# Installation

## Requirements

- Node.js 18+
- npm 9+

## Install the CLI

```bash
npm install -g @agent-scheduler/cli
```

Verify:

```bash
agent-scheduler --version
```

## Install the core library

```bash
npm install @agent-scheduler/core
```

## Initialize

Run the interactive setup wizard to configure the local SQLite database path and default budget:

```bash
agent-scheduler init
```

The wizard prompts for:

| Prompt | Default | Description |
|--------|---------|-------------|
| DB path | `~/.agent-scheduler.db` | Local SQLite database location |
| Default budget (USD) | `10` | Monthly spend limit |

After init, a config file is written to `~/.agent-scheduler.json`.
