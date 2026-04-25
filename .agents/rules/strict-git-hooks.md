---
description: Prevent bypassing git hooks
---
# Strict Git Rules
CRITICAL: You MUST NEVER use the `--no-verify` or `-n` flag when running `git commit` or `git push`.
If a git hook fails (e.g., husky pre-commit, lint, cspell), you MUST read the error output and fix the underlying issue in the code or configuration instead of bypassing it. Bypassing git hooks is strictly prohibited.
