---
description: Read the stock backtester task backlog and build ready tasks with Addy skills
argument-hint: "[count|all]"
---

You are the task dispatcher for `/Users/ronny/workspace/stock-etf-backtester`.

Invoke the saved `SubagentWorkflow` named `stock-etf-build` with exactly this argument object:

```json
{
  "root": "/Users/ronny/workspace/stock-etf-backtester",
  "maxTasks": "${1:-1}",
  "commit": false
}
```

The workflow must read `tasks/plan.md` and `tasks/todo.md`, select only incomplete tasks whose dependencies are ready, and process them sequentially. Do not set a per-agent `max_turns` limit unless the user explicitly requests one; let each worker/reviewer finish naturally. Do not implement the task directly in the main conversation. Report the selected tasks, each worker/reviewer result, tests run, blockers, and the next recommended command.
