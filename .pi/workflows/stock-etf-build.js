export const meta = {
  name: 'stock-etf-build',
  description: 'Read the stock backtest task backlog, implement ready slices, and verify them sequentially',
  phases: [
    { title: 'Discover', detail: 'Read tasks/plan.md and tasks/todo.md and select ready work' },
    { title: 'Implement', detail: 'Implement one dependency-ordered task at a time' },
    { title: 'Verify', detail: 'Review, test, and update task state before continuing' },
  ],
}

const input = args && typeof args === 'object' ? args : {}
const root = input.root || '/Users/ronny/workspace/stock-etf-backtester'
const requested = input.maxTasks ?? 1
const maxTasks = requested === 'all'
  ? 21
  : Math.max(1, Math.min(21, Number.parseInt(String(requested), 10) || 1))
const commit = input.commit === true

const taskSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    phase: { type: 'string' },
    dependencies: { type: 'array', items: { type: 'string' } },
    ready: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['id', 'title', 'phase', 'dependencies', 'ready', 'reason'],
}

phase('Discover')
const discovery = await agent(
  `You are the backlog planner for ${root}. Read AGENTS.md, tasks/plan.md, and tasks/todo.md. Do not edit files. Identify incomplete tasks in dependency order, determine which are ready based on the checklist and explicit dependencies, and return at most ${maxTasks} ready tasks plus a short reason for each. Do not invent tasks. If no task is ready, return an empty list.`,
  {
    label: 'discover stock tasks',
    agentType: 'Plan',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tasks: { type: 'array', items: taskSchema },
        blockers: { type: 'array', items: { type: 'string' } },
      },
      required: ['tasks', 'blockers'],
    },
  },
)

if (!discovery || !Array.isArray(discovery.tasks) || discovery.tasks.length === 0) {
  return {
    root,
    selected: [],
    blockers: discovery?.blockers || ['No ready incomplete task was found.'],
    reports: [],
  }
}

const selected = discovery.tasks.filter((task) => task.ready).slice(0, maxTasks)
const reports = []

for (const task of selected) {
  phase('Implement')
  const implementation = await agent(
    `Work in ${root} on exactly ${task.id}: ${task.title}. This task was selected from tasks/plan.md because: ${task.reason}. Read AGENTS.md, the complete task section in tasks/plan.md, tasks/todo.md, and only the design sections relevant to this task before editing. Use Addy's Agent Skills: using-agent-skills, incremental-implementation, test-driven-development, and the most specific applicable skill. Implement one thin vertical slice, keep the repository runnable, preserve unrelated user changes, and do not expand scope. Run focused verification and the repository checks required by the task. Update the matching checkbox in tasks/todo.md only if the acceptance criteria are actually met. ${commit ? 'The user authorized an atomic commit for this task after verification.' : 'Do not commit or push; leave the verified changes in the working tree.'} Return a structured status with changed files, tests/checks, blockers, and whether the task is complete.`,
    {
      label: `implement ${task.id}`,
      agentType: 'general-purpose',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['completed', 'blocked', 'failed'] },
          changedFiles: { type: 'array', items: { type: 'string' } },
          checks: { type: 'array', items: { type: 'string' } },
          blockers: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
          todoUpdated: { type: 'boolean' },
        },
        required: ['status', 'changedFiles', 'checks', 'blockers', 'summary', 'todoUpdated'],
      },
    },
  )

  if (!implementation || implementation.status !== 'completed') {
    reports.push({ task, implementation, review: null })
    break
  }

  phase('Verify')
  const review = await agent(
    `Review the implementation of ${task.id}: ${task.title} in ${root}. Read AGENTS.md and the task acceptance criteria. Inspect only the changes relevant to this task. Apply Addy's code-review-and-quality and code-simplification guidance, and use security or performance checks when applicable. Run the focused tests/checks again. Fix only task-related defects you can verify safely; do not broaden scope, commit, push, or undo unrelated user changes. Return whether the task is passed, the checks run, and any remaining blockers.`,
    {
      label: `verify ${task.id}`,
      agentType: 'general-purpose',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['passed', 'blocked', 'failed'] },
          checks: { type: 'array', items: { type: 'string' } },
          changedFiles: { type: 'array', items: { type: 'string' } },
          blockers: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
        required: ['status', 'checks', 'changedFiles', 'blockers', 'summary'],
      },
    },
  )

  reports.push({ task, implementation, review })
  if (!review || review.status !== 'passed') break
}

return {
  root,
  maxTasks,
  commit,
  selected,
  reports,
  next: reports.length === selected.length ? 'Run /stock-build again for the next ready task(s).' : 'Resolve the reported blocker, then rerun /stock-build.',
}
