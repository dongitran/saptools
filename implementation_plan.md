# Implementation Plan

## Goal

Improve `packages/service-flow/README.md` so it reads like a professional, modern npm package README in the same style as `packages/cf-sync/README.md`, while preserving the exact final README line used by `cf-sync`.

## Intended files

- `packages/service-flow/README.md` — rewrite and expand package documentation with a centered hero, badges, feature list, install/quick-start flow, detailed CLI reference, supported analysis patterns, storage/security notes, troubleshooting, development, related links, author, license, and the exact final line from `packages/cf-sync/README.md`.
- `implementation_plan.md` — record this documentation-only plan and verification steps.

## Research steps

- Read `packages/cf-sync/README.md` to mirror its tone, structure, badges, and final line.
- Read `packages/service-flow/package.json`, `src/cli.ts`, `src/types.ts`, and parser/linker/indexer files to accurately document commands, options, outputs, and supported CAP patterns.

## Verification steps

- Run a package-focused help command through the TypeScript source if feasible.
- Run a Markdown/file-content check to ensure the final line exactly matches `cf-sync`.
- Review `git diff` for documentation accuracy and absence of sensitive data.
