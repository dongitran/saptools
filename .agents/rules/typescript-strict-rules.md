---
# cspell:words Mindpool unvalidated
description: TypeScript strict coding rules for Mindpool — no any, no ts-ignore, Zod validation, explicit types
---
# TypeScript Strict Rules

> [!IMPORTANT]
> Mindpool runs TypeScript strict mode on both frontend (Vite) and backend (Express). These rules go beyond what `tsc --strict` enforces — they govern how AI-generated code must handle types to prevent runtime crashes and hidden bugs.

## 1. No `any` — Use `unknown` with Type Guards

- **NEVER** use `any` as a type annotation or via implicit inference.
- When a value's type is genuinely unknown (parsed JSON, external API response, `try/catch` error), type it as `unknown` and narrow with `typeof`, `instanceof`, or a Zod schema parse before use.
- Acceptable: `const err: unknown = e; if (err instanceof Error) logger.error(err.message)`
- Forbidden: `const data: any = await res.json()`

## 2. No `@ts-ignore` / `@ts-nocheck`

- **NEVER** use `@ts-ignore`, `@ts-nocheck`, or `@ts-expect-error` to silence TypeScript errors.
- If a type error appears, **fix the root cause** — correct the type definition, add a type guard, or use proper generics.
- The only exception: `@ts-expect-error // reason: <specific explanation>` in test files to assert a bad type intentionally fails. Treat it as a code smell requiring a follow-up fix.

## 3. No Non-Null Assertion Operator `!`

- **NEVER** use `value!` to assert non-null/undefined unless the value is provably non-null by construction at that exact call site.
- Use optional chaining (`?.`) for safe access and nullish coalescing (`??`) for fallbacks.
- Forbidden: `const name = user!.name`
- Correct: `const name = user?.name ?? 'Anonymous'`

## 4. No TypeScript Enums — Use `as const`

- **NEVER** use TypeScript `enum` declarations. They compile to runtime objects with reverse-mapping, causing unexpected bundle behavior.
- Instead, use `as const` objects with a derived union type:
  ```typescript
  const POOL_STATUS = { PENDING: 'pending', ACTIVE: 'active', DONE: 'done' } as const;
  type PoolStatus = typeof POOL_STATUS[keyof typeof POOL_STATUS];
  ```

## 5. Explicit Return Types on All Async Functions

- **ALWAYS** annotate async function return types explicitly.
- Inferred return types on async functions silently become `Promise<any>` when internal calls are untyped.
- Correct: `async function fetchPool(id: string): Promise<Pool>`
- Forbidden: `async function fetchPool(id: string) { ... }` (inferred return)

## 6. Typed Mongoose Lean Queries

- **ALWAYS** define a plain interface (e.g., `IPool`) for data shape separately from the Mongoose `Document` type.
- Use `.lean<IPool>()` on queries that don't need Mongoose document methods. Never cast lean results with `as SomeType`.
- Correct: `const pool = await PoolModel.findById(id).lean<IPool>()`
- Forbidden: `const pool = await PoolModel.findById(id) as any`

## 7. Validate External Input with Zod Before Assigning Types

- **ALWAYS** parse `req.body`, `req.query`, `req.params`, environment variables, and external API responses with a Zod schema before assigning a TypeScript type.
- Use `schema.safeParse()` for graceful error handling at API boundaries. Never use `as SomeType` on unvalidated external input.
- Correct: `const result = CreatePoolSchema.safeParse(req.body); if (!result.success) return res.status(400).json(...)`
- Forbidden: `const body = req.body as CreatePoolRequest`
