# AGENTS.md - 01-saptools

## Scope

This file applies to the whole `01-saptools` repository unless a nested `AGENTS.md` exists closer to the file being edited. Explicit user instructions in chat take precedence.

The `.agents/rules/` folder contains stricter reusable rules copied into this repo. Use them as defaults, but adapt source-project-specific guidance to this SAP tools CLI monorepo. Do not force Express, Mongoose, or Zod rules where they do not apply.

## Project Overview

`01-saptools` is a pnpm/turbo TypeScript ESM monorepo for SAP BTP Cloud Foundry developer tooling. It targets Node.js 20+ and uses strict TypeScript with `module` and `moduleResolution` set to `NodeNext`.

Packages:

- `@saptools/cf-sync`: `cf-sync` CLI for CF topology sync, region reads, and HANA DB binding snapshots.
- `@saptools/cf-xsuaa`: `cf-xsuaa` CLI for XSUAA credential discovery and cached OAuth tokens.
- `@saptools/cf-debugger`: `cf-debugger` CLI for CF SSH Node inspector sessions.
- `@saptools/bruno`: `saptools-bruno` CLI for CF-aware Bruno collection setup and execution.
- `@saptools/sqltools`: `sqltools-export` CLI for HANA VCAP to VS Code SQLTools settings.
- `@saptools/sharepoint-check`: `saptools-sharepoint-check` CLI for Microsoft Graph SharePoint diagnostics.
- `@saptools/cf-files`: `saptools-cf-files` CLI for CF env generation and file transfer over `cf ssh`.
- `@saptools/cf-logs`: `cf-logs` CLI for CF log snapshot, stream, parse, redaction, and local storage.

## Required Workflow

- Before modifying source code, create or update `implementation_plan.md` with the intended files, reasons, and verification steps.
- Use `rg` and direct file reads to trace existing behavior before changing it.
- Prefer existing package patterns and helpers over new abstractions.
- Keep edits scoped to the requested package or behavior.
- Treat dirty or untracked files as user work. Do not revert or overwrite them unless the user explicitly asks.
- Never run `git commit --no-verify`, `git push --no-verify`, `git commit -n`, or `git push -n`.

## Commands

Install dependencies:

```bash
pnpm install
```

Root checks:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:e2e
pnpm check
```

Package-focused checks:

```bash
pnpm --filter @saptools/cf-sync test:unit
pnpm --filter @saptools/cf-sync test:e2e
pnpm --filter @saptools/cf-sync typecheck
pnpm --filter @saptools/cf-sync lint
```

Replace the package filter with the package being changed. For documentation-only changes, a focused Markdown/spelling check is usually enough.

## TypeScript And Style

- Use TypeScript strict mode. Do not introduce `any`, unsafe casts, `@ts-ignore`, `@ts-nocheck`, or non-null assertions.
- Annotate async function return types explicitly.
- Use `import type` for type-only imports.
- Preserve ESM and `NodeNext` semantics. Include file extensions in relative runtime imports when the existing package requires them.
- Do not add `console.*` in source. Follow existing CLI output patterns such as package output helpers or `process.stdout.write` and `process.stderr.write`.
- Keep functions small and readable. Use guard clauses instead of deeply nested branches.
- Do not add commented-out code. Comments should explain constraints or reasoning, not restate code.
- Apply the rule of three before extracting shared utilities unless the repo already has an obvious helper.

## Architecture Notes

- `cf-sync` is the central CF topology package. Reuse its CF wrappers, region handling, structure reads, and DB target logic when possible.
- `cf-xsuaa`, `bruno`, `sqltools`, `cf-files`, and `cf-logs` integrate with CF app metadata, VCAP data, or local SAP tooling state. Keep package boundaries clear.
- `packages/cf-sync/src/structure.ts` is already near the 700-line guardrail. Do not add new responsibilities there; split by lifecycle or storage concern.
- When parsing CLI output or VCAP payloads, prefer typed parsers and deterministic errors over ad hoc string handling.
- Generated local state belongs under user-local paths such as `~/.saptools`, not inside the repository.

## Testing

- Unit tests use Vitest. Add or update focused unit tests for parser, state, selection, and command behavior changes.
- E2E tests use Playwright and fake-backed CLIs where available. Keep tests deterministic and isolated.
- Do not run live CF, SharePoint, or credential-dependent E2E tests unless the user requested it and the required environment variables are present.
- Prefer role, label, or test-id locators in Playwright. Avoid arbitrary sleeps; use web-first assertions or explicit process/network signals.
- Coverage thresholds are enforced per package. Do not weaken coverage or config to make a change pass.

## Security

This repo handles SAP and Microsoft credentials. Treat the following as sensitive:

- `SAP_EMAIL`, `SAP_PASSWORD`, CF tokens, and CF app environment output
- XSUAA `clientSecret`, OAuth access tokens, and cached token files
- HANA usernames, passwords, certificates, and SQLTools connection settings
- SharePoint tenant IDs, client IDs, client secrets, and Graph tokens
- local snapshots and stores under `~/.saptools`

Rules:

- Never hardcode secrets or commit generated credential files.
- Keep `.env*`, `default-env.json`, `hana-credentials.json`, generated SQLTools settings with passwords, and local `~/.saptools/*` data out of git.
- Redact command failures and logs that might include credentials.
- If a diff exposes a secret, stop and alert the user before doing anything else.

## Git And Release

- Respect Husky hooks and fix hook failures instead of bypassing them.
- Do not change package versions, publish config, provenance settings, or workflow release behavior unless the task explicitly asks.
- Use concise commit messages if the user asks for a commit.
