---
# cspell:words Mindpool
description: Code quality rules for Mindpool — file/function size limits, no premature abstraction, no commented-out code, comments explain why
---
# Code Quality Guardrails

> [!IMPORTANT]
> These rules prevent the most common AI code generation failure modes: over-engineering, code bloat, and premature abstraction. Follow them to keep the codebase navigable and maintainable.

## 1. File and Component Size Limits

- **NEVER** let a server-side file exceed **700 lines**. When a file approaches this limit, split it by responsibility.
- **NEVER** let a React component file exceed **200 lines**. Extract sub-components or move data logic into a custom hook.
- These are hard limits, not guidelines. If the limit is approached, stop and refactor before adding more code.

## 2. Function Size and Complexity Limits

- **NEVER** write a function longer than **50 lines**. If it exceeds this, extract named helper functions within the same file.
- **NEVER** exceed a cyclomatic complexity of **10** per function (more than 10 branches/conditions). Use early returns (guard clauses) to flatten nested conditionals.
- Correct pattern — guard clause first:
  ```typescript
  if (!pool) return res.status(404).json({ error: 'Pool not found' });
  if (pool.status !== 'active') return res.status(400).json({ error: 'Pool not active' });
  // happy path continues
  ```

## 3. No Premature Abstraction — Rule of Three

- **NEVER** create a helper function, utility, or abstraction for code that exists in only one or two places.
- Apply the Rule of Three: the first time you write it, write it inline. The second time, copy it. The third time, extract a shared utility.
- Creating a utility for a one-time operation forces future readers to find and understand the abstraction for no benefit.

## 4. Prefer Editing Existing Files Over Creating New Ones

- **ALWAYS** search the codebase for where similar functionality already exists before creating a new file.
- New files add cognitive overhead and navigation cost. Extend existing files when cohesion allows.
- Only create a new file when the new code has a genuinely distinct responsibility that does not fit any existing module.

## 5. No Commented-Out Code

- **NEVER** commit commented-out code. Delete it completely — git history preserves all past versions.
- The only exception: `// TODO(reason): <description>` comments pointing to a specific, known future task.
- Dead code in comments creates confusion about whether the code is live behavior or a past experiment.

## 6. Comments Explain Why, Not What

- **NEVER** write comments that restate what the code already clearly shows.
- Comments must explain reasoning, constraints, or context that cannot be inferred from reading the code.
- Noise (forbidden): `// increment the counter`, `// return the result`
- Signal (required): `// Redis TTL is 5 minutes — matches the LLM token expiry window`, `// MongoDB sessions require explicit commit or the transaction rolls back on function exit`

## 7. No `console.log` in Committed Code

- **NEVER** commit `console.log`, `console.error`, or `console.warn` calls in application code.
- Use the project's structured logger for all runtime output so log levels and formatting are consistent.
- `console.log` in production pollutes logs, bypasses log levels, and can leak sensitive data.
- Enforce with ESLint's `no-console` rule set to `error`. If the rule is missing, add it rather than committing the log.
