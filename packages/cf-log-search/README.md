# @saptools/cf-log-search

Historical full-text and structured search over SAP BTP Cloud Foundry application logs, already
ingested into SAP Cloud Logging's OpenSearch backend (`logs-cfsyslog-*`). Complements `cf-logs`,
which is bounded by Cloud Foundry's short-lived loggregator buffer and cannot search history.

```bash
npm install -g @saptools/cf-log-search
cf-log-search search --app my-app --level error --since 24h
```

Full usage, command reference, and the `trace_id` field's source-type-dependent meaning are
documented in [`.skills/cf-log-search/SKILL.md`](../../.skills/cf-log-search/SKILL.md).

## Development

```bash
pnpm --filter @saptools/cf-log-search build
pnpm --filter @saptools/cf-log-search typecheck
pnpm --filter @saptools/cf-log-search lint
pnpm --filter @saptools/cf-log-search test:unit
pnpm --filter @saptools/cf-log-search test:e2e
```

See `CHANGELOG.md` for release history.
