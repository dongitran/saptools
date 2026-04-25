---
# cspell:words Bitwarden Mindpool
description: Security rules for Mindpool — no secrets in code, input validation, no eval, safe MongoDB queries, safe error responses
---
# Security Guardrails

> [!IMPORTANT]
> Mindpool handles LLM API keys, MongoDB credentials, and Redis connection strings. The Express API is publicly accessible in production on GKE. Security mistakes here can result in credential leaks, data breaches, or remote code execution. These rules are non-negotiable.

## 1. Never Commit Secrets or Credentials

- **NEVER** put API keys, passwords, connection strings, tokens, or credentials directly in source code — not even in comments or example values.
- All secrets MUST come from environment variables. The `.env` file is in `.gitignore` and must stay there.
- CI secrets are stored in GitHub Actions secrets (managed via Bitwarden sync in `.agents/config/secrets.yml`), never in the repository.
- If you accidentally discover a secret in a diff or staged file, **STOP immediately** and alert the user before committing.

## 2. Validate All External Input at the API Boundary

- **ALWAYS** validate `req.body`, `req.query`, and `req.params` with a Zod schema before any business logic runs.
- Use `schema.safeParse()` and return `400` with a structured error if validation fails. Never trust raw request data.
- This applies to all Express routes — pool creation, message sending, settings updates, etc.
- Correct: `const result = CreatePoolSchema.safeParse(req.body); if (!result.success) return res.status(400).json({ error: result.error.format() })`

## 3. No `eval()` or `new Function()` with User Input

- **NEVER** use `eval()`, `new Function()`, `vm.runInThisContext()`, or any dynamic code execution with user-supplied data.
- These represent critical Remote Code Execution (RCE) vulnerabilities. There is no safe way to use them with untrusted input.
- If dynamic evaluation seems needed, reconsider the architecture and propose an alternative to the user.

## 4. Safe MongoDB Queries — Parameterized Mongoose Methods Only

- **ALWAYS** use Mongoose's built-in query methods (`findById`, `findOne`, `find`, `updateOne`, etc.) with typed parameters.
- **NEVER** construct query objects from user input via string concatenation or `JSON.parse(userInput)` — this enables NoSQL injection.
- Correct: `PoolModel.findOne({ _id: poolId, status: 'active' })`
- Forbidden: `PoolModel.findOne(JSON.parse(req.body.filter))` or string-built query objects

## 5. Never Expose Stack Traces or Internal Errors in API Responses

- **NEVER** return `error.stack`, database error messages, Mongoose validation internals, or any system-level detail in API responses.
- Production error handlers MUST return generic messages: `{ "error": "An internal error occurred" }`.
- Log the full error server-side with a structured logger and a correlation ID for debugging.
- The Express global error handler must explicitly strip all internal error details before responding.

## 6. Never Log Sensitive Data

- **NEVER** log passwords, API keys, tokens, connection strings, or PII (personal identifiable information).
- Request/response logging middleware must scrub fields matching patterns like `password`, `token`, `secret`, `key`, `authorization`.
- When in doubt about whether a field is sensitive, scrub it.
