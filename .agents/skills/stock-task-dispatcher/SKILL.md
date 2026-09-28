---
name: stock-task-dispatcher
description: Route implementation requests in the stock-etf-backtester repository through tasks/plan.md and tasks/todo.md, selecting ready tasks and running the bounded stock-etf-build workflow. Use when the user asks to implement, continue, build, or work through the project backlog.
---

# Stock Task Dispatcher

This repository's implementation source of truth is:

- `tasks/plan.md` for task details, acceptance criteria, dependencies, and verification.
- `tasks/todo.md` for completion state and checkpoints.

When the user asks to implement or continue project work:

1. Read `AGENTS.md`, `tasks/plan.md`, and `tasks/todo.md`.
2. Preserve unrelated user changes and never overwrite an incomplete plan.
3. Select the first incomplete task whose dependencies are satisfied.
4. For one bounded run, invoke the saved `SubagentWorkflow` named `stock-etf-build` with `root` set to `/Users/ronny/workspace/stock-etf-backtester`.
5. Let the workflow run the worker and verification stages sequentially; do not parallelize dependent implementation tasks.
6. Use Addy's `using-agent-skills`, `incremental-implementation`, and `test-driven-development`, plus the most specific API/UI/debug/security/performance skill.
7. Stop and report when a task is blocked, tests fail without a safe fix, or a product decision is needed.

The workflow defaults to one task per run. It does not impose a per-agent `max_turns` limit unless the user explicitly requests one. Use `/stock-build all` only when the user explicitly wants the entire remaining backlog processed in one run.
