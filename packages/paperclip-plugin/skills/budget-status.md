# budget-status

Use this skill to check the current AI API usage and budget status for this agent.

## When to use

- Before starting a large or expensive task
- When you suspect budget limits may be approaching
- When a previous heartbeat was blocked due to budget constraints

## How to use

Run the following command to see current usage against all configured budgets:

```bash
agent-scheduler status
```

To check whether the budget gate would block a heartbeat right now:

```bash
agent-scheduler check-budget --agent-id $PAPERCLIP_AGENT_ID
```

- Exit code `0` → budget OK, proceed normally
- Exit code `1` → budget exceeded, do not start expensive work

## Interpreting output

The `status` command shows:

- **Today**: total USD spent today
- **This month**: total USD spent this calendar month
- **Budgets**: per-budget progress bars with percentage used

Color coding:
- Green (`< 80%`) — safe
- Yellow (`80–99%`) — approaching limit
- Red (`≥ 100%`) — limit exceeded

## Configuration

Budgets are managed with:

```bash
# Create or update a budget
agent-scheduler budget set default 10 --period monthly --action block

# List all budgets
agent-scheduler budget list
```

Budget actions:
- `alert` — log a warning but allow the heartbeat to proceed
- `block` — return exit code 1, blocking the heartbeat (used by the Paperclip hook)
- `queue` — (future) queue tasks for later execution

## Notes

- The default DB path is `~/.agent-scheduler.db`
- Configure a custom path with `agent-scheduler init`
- The Paperclip hook runs `check-budget` automatically before each heartbeat; you only need to call it manually for debugging
