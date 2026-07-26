<div align="center">

# 🔎 `@saptools/hana-lens`

**Build a compact SAP CAP CSN cache for fast entity search and dense schema descriptions.**

Scan every matching CAP package in a workspace, virtually link local siblings, compile each package in an isolated `@sap/cds` worker, then query one minified `.hana-lens-cache.json` — no more opening huge CSN files or loading an entire monorepo just to answer *"where is this entity and what columns does it have?"*

[![npm version](https://img.shields.io/npm/v/@saptools/hana-lens.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/hana-lens)
[![license](https://img.shields.io/npm/l/@saptools/hana-lens.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/hana-lens.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![install size](https://packagephobia.com/badge?p=@saptools/hana-lens)](https://packagephobia.com/result?p=@saptools/hana-lens)
[![types](https://img.shields.io/npm/types/@saptools/hana-lens.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [FAQ](#-faq)

</div>

---

## ✨ Features

- 🧭 **Workspace package discovery** — recursively finds `package.json` files whose `name` starts with your CAP package prefix
- 🔗 **Virtual sibling links** — creates local `node_modules/<scope>` symlinks so cross-package CDS references resolve without publishing packages
- 🧪 **Isolated CAP compilation** — resolves `@sap/cds` from the analyzed workspace first, then runs one fresh Node.js worker per package
- 🧯 **Resilient cache builds** — skips individual model failures by default, reports them, and provides `--strict` CI enforcement
- 🎯 **Purpose-scoped caches** — defaults to HANA persistence definitions, with explicit service-layer and full-model views
- 🏷️ **Origin-aware CSN** — injects `@hanaLens.packageName` into definitions so results show the package that produced each entity
- 🪶 **Minified cache** — writes `.hana-lens-cache.json` with plain `JSON.stringify(ast)` and no formatting whitespace
- 🔍 **Fuzzy + regex search** — returns deterministic definition and field matches, with explicit totals whenever bounded CLI output is truncated
- 🧾 **Dense descriptions** — preserves type parameters, arrays, enum members, keys, and computed markers in compact terminal-friendly lines
- 🛡️ **Safe association expansion** — follows `cds.Association` and `cds.Composition` targets with depth and circular-reference guards
- 🧩 **CLI & typed API** — core cache, search, describe, package scanning, and build functions are exported for scripts
- 🪶 **Small + boring** — bounded isolated regex execution with a linear-time fallback, explicit CAP compiler requirements, and no resident daemon

---

## 📦 Install

```bash
# Global CLI
npm install -g @saptools/hana-lens

# Or as a dependency
npm install @saptools/hana-lens
# pnpm add @saptools/hana-lens
# yarn add @saptools/hana-lens
```

> [!NOTE]
> Requires **Node.js ≥ 20**. `build-cache` requires **`@sap/cds`** in the analyzed workspace (recommended) or alongside the `hana-lens` CLI. The regex parser is available only with `--allow-fallback`; it is degraded and omits aspect-inheriting entities, projections, enums, and numeric precision.

---

## 🚀 Quick Start

```bash
# 1. Build a persistence-oriented DB cache (the default scope)
hana-lens build-cache --dir ./workspace --prefix @my-cap/

# 2. Search definitions with typo-tolerant fuzzy matching
hana-lens search BusinessReq

# 3. Describe a persistence entity in dense form
hana-lens describe my.data.BusinessRequest

# 4. Expand associations/compositions when you need nearby columns too
hana-lens describe my.data.BusinessRequest --expand
```

After the first cache build, `./workspace/.hana-lens-cache.json` is ready for offline `search` and `describe` commands. Run those commands from the directory that contains the cache.

---

## 🧰 CLI

### 🏗️ `hana-lens build-cache --dir <workspace_path> --prefix <package_prefix> [--kind db|service|all] [--allow-fallback] [--strict]`

Scan a CAP workspace, compile every matching package in isolation, and write a minified, purpose-scoped CSN cache.

```bash
# Default: persistence entities and their supporting types/aspects
hana-lens build-cache --dir ./workspace --prefix @my-cap/

# Service/OData definitions
hana-lens build-cache --dir ./workspace --prefix @my-cap/ --kind service

# Compatibility mode: retain the complete pre-0.4 model
hana-lens build-cache --dir ./workspace --prefix @my-cap/ --kind all

# Fail if any package or conflicting definition fails
hana-lens build-cache --dir ./workspace --prefix @my-cap/ --strict
```

| Flag | Description |
| --- | --- |
| `--dir <workspace_path>` | Root directory to scan recursively |
| `--prefix <package_prefix>` | Package-name prefix to include, for example `@my-cap/` |
| `--kind db\|service\|all` | Cache scope: persistence-oriented `db` (default), service/OData `service`, or the prior full-model `all` |
| `--allow-fallback` | Opt into the degraded regex parser only for packages where `@sap/cds` cannot be resolved |
| `--strict` | Abort if any package fails to compile or any definition name has conflicting shapes |

What it does:

- ignores `node_modules`, `.git`, `dist`, and `gen`
- stops recursion once it finds a matching package root
- resolves duplicate package names by folder match, then uses folder-derived fallbacks; if two fallback names still collide, keeps one deterministic survivor and excludes the rest rather than dropping the whole group
- creates virtual sibling links under each package's `node_modules/<scope>`
- removes broken symlinks before relinking, and prunes stale links left over from packages no longer in scope
- isolates one unlinkable package name, or one broken symlink target, without aborting linking for every other package; rolls back every symlink this run created if linking still fails
- spawns one worker process per package before calling `@sap/cds.compile(['*'])`
- resolves `@sap/cds` from each analyzed package/workspace before trying the CLI installation
- skips failed packages with a bounded stderr summary by default; `--strict` restores abort-on-any-failure behavior; a spawn-level failure (not just a compiler error) is skipped the same way instead of crashing the build
- keeps a worker's compiled payload even if it later exits non-zero or is killed by a signal, as long as a valid result was already written
- classifies an unresolvable module reference separately from a CDS model-semantics error in skip reasons, and never attributes a `cds.*` framework built-in to whichever package compiled first
- filters successful compiler output by CAP semantics before merging and writing the cache; `@cds.persistence.skip: 'if-unused'` is resolved by actual usage, so a referenced code list stays in `db` and an unreferenced one does not
- annotates definitions with `@hanaLens.packageName`
- silently collapses identical shared definitions; different definitions with the same fully qualified name warn and deterministically keep whichever copy has the more complete element set (independent of processing order), falling back to preferring persistence definitions over projections only when neither is more complete (`--strict` makes conflicts fatal)
- writes `.hana-lens-cache.json` as newline-free minified JSON

| Kind | Cached definitions |
| --- | --- |
| `db` (default) | Persistence entities classified by CAP shape, including physical tables declared inside a service body, plus free types/aspects. Queries and projections (including DB views), external definitions, and persistence-skipped definitions are excluded — except a `'if-unused'` skip that is actually referenced elsewhere in the model, which stays in `db` since CAP still persists it. Contexts are excluded. |
| `service` | The non-persistence layer: service-owned definitions, queries/projections, external or persistence-skipped definitions (including an unreferenced `'if-unused'` skip), operations, contexts/events/annotations, and free types/aspects. Physical persistence entities are excluded even when declared inside a service body. |
| `all` | The complete compiled model, matching the pre-0.4 cache scope. |

All matching packages are still compiled before scoping. Together, `db` and `service` account for every `all` definition; free top-level types/aspects intentionally appear in both for reference closure. The success summary preserves `cached=`, `packages=`, and `file=`, then reports `scan_warnings=`, `excluded_packages=`, `compiled=`, `skipped=`, `via=`, and `kind=`. `cached=` is the scoped definition count; `packages=` is the discovered total; `scan_warnings=` counts directories excluded during scanning because their `package.json` was malformed or unreadable (also reported on stderr); `excluded_packages=` counts packages dropped by a fallback-name collision that still collided after folder-derived renaming (also reported on stderr); and `compiled=`/`skipped=` describe worker outcomes before filtering. `via=cds` means every successful package used CAP compilation; `via=fallback` means every successful package used the degraded parser; mixed builds report `via=cds+fallback(<count>)`.

> [!WARNING]
> `--allow-fallback` cannot reliably identify service ownership, queries/projections, or CAP persistence flags. Its `db` and `service` scopes are therefore incomplete in addition to the parser limitations described above; any fallback use prints a degraded-cache warning to stderr.

> [!TIP]
> `build-cache` is the expensive step. Run it after model changes, then use `search` and `describe` repeatedly without recompiling the workspace.

### 🔍 `hana-lens search <keyword> [--regex]`

Search through cached `csn.definitions` keys and print up to 10 matches in dense `entity|package` form.

```bash
hana-lens search BusinessReq
hana-lens search businessrequest
hana-lens search '^my\.service\..*Request$' --regex
hana-lens search '^BusinessRequest$' --regex
```

| Flag | Description |
| --- | --- |
| `--regex` | Treat `<keyword>` verbatim as a case-insensitive regular expression and disable fuzzy matching |

Example output:

```text
my.service.BusinessRequest|@my-cap/sales
my.service.BusinessRequestItem|@my-cap/sales
```

Default mode is case-insensitive and typo-tolerant, ordered by where the keyword matches (earlier wins) rather than by candidate length, then by definition name; a typo anywhere in a namespace segment matches, not only in the final component; the keyword is capped at 256 characters, the same bound already applied to regex patterns. Substring matches are retained, while distant fuzzy guesses are filtered out. A query with no results prints `No matches for "<keyword>"`. Regex mode tests every dot-separated segment of each definition name (the fully qualified name, each namespace segment, and the final component), so `^BusinessRequest$` or `^service$` can both match `my.service.BusinessRequest`; matches remain deduplicated and ordered by definition name. Regex input is preserved verbatim (a whitespace-only pattern is valid and matches literal spaces), capped at 256 characters, and evaluated in an isolated native-JavaScript worker with a fixed timeout before a linear RE2JS fallback. This worker boundary provides the ReDoS protection; a fallback attempt always prints a stderr warning about the syntax/Unicode differences involved, and if the fallback engine itself then rejects the pattern, the message says so explicitly rather than calling it invalid syntax outright. The typed API returns the full sorted match set. When the CLI has more than 10 results, it appends `... showing 10 of M matches` after the visible rows.

### 🔎 `hana-lens search-field <keyword> [--regex]`

Search cached element names and report every matching field, including multiple matches from the same entity. Fuzzy matches are ranked deterministically; regex matches are ranked by matched field and never labeled exact. The CLI prints up to 25 rows and appends `... showing 25 of M matches` when more are available.

```text
Field matching "status" found in:
- my.service.BusinessRequest (exact: status)
- my.service.BusinessRequest (matched: statusText)
```

When no field matches, the command prints `No field matches for "<keyword>"` and exits successfully.

### 🔗 `hana-lens references <entity_name>`

List definitions that point to an entity through an association/composition, a type reuse (`type: my.master.Customer` on another element), or a projection/query source. Direct references name the field; a type-reuse reference adds a `, type reference` marker; projection/query sources use the stable `(projection)` marker and appear once per source.

```text
Incoming References to [my.master.Customer]:
- my.service.BusinessRequest (via field: customer)
- my.service.CustomerLink (via field: customer, type reference)
- my.service.CustomerView (via field: (projection))
```

Rows are sorted by entity and field. An exact fully qualified name wins over longer suffix matches. A unique short name resolves directly; when a short name matches multiple definitions, the CLI explicitly lists the bounded candidate set and states that the displayed references are their union. The CLI shows at most 25 rows, then appends `... showing 25 of M references` when truncated. An entity with zero incoming references prints an explicit `(no incoming references found)` line rather than leaving just the header. Requesting an entity absent from the cache fails with `Entity not found: <name>`.

### 🧾 `hana-lens describe <definition_name> [--expand] [--with-annotations]`

Print one cached definition without padded columns, tables, or emojis.

```bash
hana-lens describe my.service.BusinessRequest
hana-lens describe my.service.BusinessRequest --expand
hana-lens describe my.service.BusinessRequest --with-annotations
hana-lens describe BusinessRequest
```

| Flag | Description |
| --- | --- |
| `--expand` | Follow `cds.Association` and `cds.Composition` targets with a safety depth limit of 2; a target past the limit prints a `truncated` marker instead of stopping silently |
| `--with-annotations` | Print `@`-annotations, both on the definition itself and on each element |

Dense output example:

```text
[PK] [computed] reqID: cds.String(36)
[computed] createdAt: cds.Timestamp
[virtual] balance: cds.Decimal(9, 2)
[not null] status: cds.String
[localized] title: cds.String(120)
amount: cds.Decimal(3, 1)
history: array of cds.Map
labels: array of { value, label }
customer: cds.Association to my.master.Customer
items: cds.Composition to many my.service.BusinessRequestItem ON [items.requestID = reqID]
- [PK] ID: cds.Integer
- name: cds.String(80)
```

`[PK]` marks `key: true`; `[computed]` marks `@Core.Computed`; `[virtual]`, `[not null]`, and `[localized]` mark the element's respective CSN flags; all that apply appear together. Associations and compositions include their target — an inline/anonymous aspect target (`Composition of many { ... }` with no named entity) renders its element names the same way a `{ elements }` type does — add `many` for to-many cardinality, and append a valid `ON` expression when present. A bound action/function's parameters are printed alongside a non-empty elements body (its return-type shape), not only when it has no elements. Expansion reports compact `missing`, `ambiguous`, or `circular` markers when a target cannot be expanded safely, prefixes and labels every expanded line with its nesting depth and resolved target name even when the target itself has no elements, and marks a target past the depth limit `truncated` rather than silently stopping.

`describe` accepts either an exact fully qualified name or a unique final segment. Ambiguous short names fail with a deterministic, bounded candidate list and ask for the full name instead of selecting an arbitrary definition.

With `--with-annotations`, annotations on the definition itself (e.g. `@readonly` on a service-exposed entity) print on their own line before the elements, in addition to each element's own annotations:

```text
@readonly=true @title="Business Request"
[PK] reqID: cds.String(36)
status: cds.String @Common.ValueList={"CollectionPath":"Statuses"}
```

Definitions without elements retain their useful type information. Scalar and association typedefs use the same type text as fields, enums include assigned values when they differ from their key, and actions/functions start with `(action)`/`(function)` before their parameters and return type:

```text
cds.String(120)
cds.Association to my.master.Customer
cds.String enum[SUBMITTED = "submitted", REJECTED]

(action)
- param requestID: cds.UUID
- returns: cds.Boolean
```

Definitions without elements, a usable type, an enum, or an operation signature print `(no elements)`.

---

## 📁 Output Files

`hana-lens` writes one cache file in the workspace directory you pass to `build-cache`:

```text
<workspace>/.hana-lens-cache.json # minified merged CSN definitions with @hanaLens.packageName metadata
```

The cache is intentionally newline-free JSON to reduce disk I/O and make follow-up reads cheap. It is generated state and should not be committed.

<details>
<summary><b>🔬 Shape of <code>.hana-lens-cache.json</code></b></summary>

```jsonc
{
  "definitions": {
    "my.service.BusinessRequest": {
      "kind": "entity",
      "@hanaLens.packageName": "@my-cap/sales",
      "elements": {
        "reqID": { "key": true, "type": "cds.String", "length": 36 },
        "customer": { "type": "cds.Association", "target": "my.master.Customer" }
      }
    }
  }
}
```

</details>

> [!IMPORTANT]
> Prefer the CLI commands or exported APIs over hand-editing the cache. Rebuild it from source CAP models whenever the workspace changes.

---

## 🧩 Typed API

```ts
import { CACHE_KINDS, buildCache, describeEntity, readCache, searchDefinitions } from "@saptools/hana-lens";
import type { CacheKind } from "@saptools/hana-lens";

const kind: CacheKind = CACHE_KINDS.DB;
await buildCache("./workspace", "@my-cap/", { kind });
const cache = await readCache("./workspace");
const matches = searchDefinitions(cache, "BusinessReq", false);
const description = describeEntity(cache, matches[0].name, true);
```

Exported helpers include cache IO, workspace package scanning/linking, cache building, search, and describe functions. `CACHE_KINDS`, `CacheKind`, `parseCacheKind`, and `applyCacheKindFilter` expose the same scope contract to typed callers.

---

## ❓ FAQ

<details>
<summary><b>Why does <code>build-cache</code> create symlinks?</b></summary>

CAP workspaces often reference sibling packages before they are published or installed. The virtual auto-linker mirrors those siblings into each package's `node_modules/<scope>` so `@sap/cds` can resolve local models during isolated compilation.

</details>

<details>
<summary><b>Why compile each package in a separate process?</b></summary>

`@sap/cds` keeps process-level compiler state. Compiling many packages in one Node.js process can merge models incorrectly or crash. `hana-lens` avoids that by spawning one worker per package.

</details>

<details>
<summary><b>Is <code>.hana-lens-cache.json</code> safe to commit?</b></summary>

Usually no. It is generated local state and may reveal internal entity names, namespaces, associations, and package structure. Keep it out of git and rebuild it locally or in CI when needed.

</details>

<details>
<summary><b>Does <code>search</code> recompile CAP models?</b></summary>

No. `search` and `describe` only read `.hana-lens-cache.json`. Re-run `build-cache` after changing CDS models or package boundaries.

</details>

<details>
<summary><b>What happens with circular associations?</b></summary>

`describe --expand` tracks visited targets and prints a compact `circular` marker instead of recursing forever.

</details>

---

## 🛠️ Development

From the monorepo root:

```bash
pnpm install
pnpm --filter @saptools/hana-lens build
pnpm --filter @saptools/hana-lens typecheck
pnpm --filter @saptools/hana-lens lint
pnpm --filter @saptools/hana-lens test:unit
pnpm --filter @saptools/hana-lens test:e2e
```

The e2e suite uses temporary mock CAP workspaces and the built `dist/cli.js`; it does not require live SAP BTP, CF, or SharePoint credentials.

---

## 🗒️ Changelog

### `0.5.0` — Reference completeness, definition-level annotations, and contained build failures

- resolves `references` through type reuse (not only associations/compositions) and parameterized projection sources, and states explicitly when an entity has zero incoming references instead of leaving a bare header
- surfaces annotations on the definition itself under `--with-annotations`, not only on its elements; also keeps a bound operation's parameters when it also has a non-empty elements body, and renders an anonymous-aspect composition target by its inline element names
- fixes cache-merge quality to keep whichever copy of a conflicting definition has the more complete element set, independent of processing order, instead of a projection-only heuristic that could keep a strictly poorer copy
- separates the distinct-conflicting-name count from the pairwise-conflicting-copy count in merge warnings, and bounds the "+more names" suffix by names actually left to show
- rejects a missing `--kind` value, a repeated `--dir`/`--prefix`/`--kind` flag, and extra positional arguments instead of silently defaulting, ignoring the repeat, or dropping the extra argument; suggests the closest command on a top-level typo
- accounts for fallback-name-collision exclusions in a new `excluded_packages=` build summary field, keeps one deterministic survivor instead of dropping an entire colliding group, prunes stale symlinks from packages no longer in scope, and rolls back every symlink a run created if linking still fails partway through
- isolates a spawn-level failure (e.g. descriptor exhaustion) as a per-package skip instead of crashing the whole build, and no longer discards a compiled payload a worker already wrote just because it later exited non-zero or was killed by a signal
- classifies an unresolvable-module compile error separately from a CDS model-semantics error in skip reasons, and never attributes a `cds.*` framework built-in (e.g. `cds.outbox.Messages`) to whichever package happened to compile it first
- resolves `@cds.persistence.skip: 'if-unused'` by actual reference usage: a referenced code list (e.g. `sap.common.Currencies`) stays in `db`, an unreferenced one does not
- fixes `--expand` to depth-prefix and label non-element target branches (previously ambiguous when several targets expanded to the same shape at the same depth) and to mark a target past the depth limit `truncated` instead of silently stopping
- ranks fuzzy search matches by where the keyword starts rather than by candidate length, matches a typo anywhere in a namespace segment rather than only the final one, and caps the fuzzy keyword length the same way the regex pattern length was already capped
- reports honestly when a regex fallback attempt's own rejection — not the pattern's syntax — is what actually failed after a native-engine timeout, and always warns before evaluating on the fallback engine
- **breaking:** `references` output gains an explicit no-references line and a `viaType` marker on type-reuse rows; merge-conflict and fallback-collision-exclusion warning wording changes to separate names from copies; `--expand` output gains depth-prefixed/labeled non-element branches and a `truncated` marker; regex-fallback failure messages are reworded; adds `excluded_packages` to `PackageScanResult` and the build summary line, `viaType` to `IncomingReference`, and `targetAspect`/`virtual`/`notNull`/`localized` to the typed API

### `0.4.5` — Flag-typo coverage, scan-warning accounting, and atomic cache writes

- rejects a one-edit typo of any known flag on every command (`build-cache`, `search`, `search-field`, `describe`), not only `--kind`
- classifies scan-time `package.json` failures as malformed JSON or an unreadable file (with its error code when available) instead of one generic label, and surfaces the excluded-directory count via `scan_warnings=` in the build summary plus a dedicated stderr warning
- writes the cache file through a temp-file-then-rename so a process killed mid-write can never leave a torn `.hana-lens-cache.json` behind
- moves the `... showing N of M` truncation footer for `search`, `search-field`, and `references` to stderr so truncated `stdout` stays homogeneous result rows
- **breaking:** `scanForPackages` now returns `{ packages, warnings }` instead of a bare package array; `formatSearchResults`, `formatFieldSearchResults`, and `formatIncomingReferences` no longer include the truncation footer in their return value; adds `PackageScanWarning`/`PackageScanResult`/`PackageSkip` to the typed API

### `0.4.4` — Fallback parser correctness, cache safety, and flag validation

- recognizes `Composition of` (real CDS syntax; the invalid `to` keyword is no longer required) and explicit `to one`/`of one` cardinality in the degraded regex fallback parser, for both `Association` and `Composition`
- keeps `__proto__`-named entities intact through cache builds and stops `describe`/`references` from resolving inherited `Object.prototype` members as phantom entities
- rejects `--kind` misspellings before compiling or writing a cache instead of silently falling back to the `db` default
- engages `--allow-fallback` when a resolved `@sap/cds` install fails to load or exposes no `compile()` API, while keeping genuine CDS model errors fatal with a clarifying message
- isolates a malformed `package.json` to its own directory during workspace scanning instead of aborting the entire scan
- exports `findPreferredTargetCandidates` and `findReferenceTargetCandidates` from the typed API

### `0.4.3` — Cross-package scope and reference fixes

- aggregates projection, external, and persistence-skip shape across every package copy of an FQN, preventing plain provider copies of service models from leaking into `db`
- keeps genuine service-local persistence entities available in both `db` and `service`
- unions reference targets for short names even when an exact definition key shadows namespaced entities, while preserving exact fully qualified lookup

### `0.4.2` — Scope correctness and read-command consistency

- classifies plain service-local entities by persistence shape before service ownership, retaining physical CAP tables in the default `db` cache
- makes `db`/`service` scope coverage complete by routing contexts, events, annotations, and other non-persistence definitions to `service`
- removes the obsolete nested-quantifier regex heuristic while preserving the parent length error and isolated worker timeout plus linear fallback
- preserves whitespace-significant regexes, matches definition regexes against both FQNs and final segments, and surfaces linear-engine compile errors honestly
- resolves unique short names in `describe`, reports deterministic ambiguity, gives exact reference targets precedence, and discloses multi-target reference unions
- prints explicit no-match messages for definition and field searches while preserving the existing 10/25/25 result caps

### `0.4.1` — Regex execution hardening

- isolates native JavaScript regex evaluation in a bounded worker with a 200 ms timeout and forced termination
- falls back to the linear RE2JS engine after native timeouts while preserving native JavaScript matching as the primary path
- validates worker requests and responses, clears inherited Node injection variables, and keeps invalid-pattern errors deterministic

### `0.4.0` — RC2 A+B

- changes `build-cache` to a persistence-oriented `db` scope by default, adds `--kind db|service|all`, reports `kind=`, and exposes the scope contract through the typed API
- preserves full package compilation and failure reporting while filtering cached definitions before merge; `--kind all` retains the pre-0.4 full-model behavior
- renders association targets/cardinality, typedefs, operations, assigned enum values, and independent key/computed markers from cached CSN
- filters irrelevant fuzzy guesses, makes field labels/ranking truthful, and includes bounded projection/query references with honest totals and missing-entity errors
- keeps compilation, cache filename/schema, read compatibility, and deterministic output unchanged

### `0.3.2` — RC2-B

- preserves CAP type fidelity in `describe` for Decimal precision/scale, scalar and anonymous-struct arrays, and named enum definitions
- separates `[PK]` (`key: true`) from `[computed]` (`@Core.Computed`)
- returns full deterministic definition and field search results from the APIs while bounding CLI output to 10/25 rows with honest `... showing N of M matches` totals
- leaves compilation, cache schema, and `build-cache` package scope unchanged

### `0.3.1` — RC1

- resolves `@sap/cds` workspace-first and CLI-second, fails closed when CDS is entirely unavailable, and makes degraded fallback explicit with `--allow-fallback` plus `via=` reporting
- isolates per-package compiler failures with deterministic settled outcomes and summaries; `--strict` aborts for CI
- replaces unconditional duplicate-name failures with signature-aware identical-definition collapse and visible conflict handling
- keeps cache reads and the `search`, `search-field`, `references`, and `describe` output formats unchanged

---

## 🌐 Related

- ☁️ [`@saptools/cf-sync`](https://www.npmjs.com/package/@saptools/cf-sync) — cache SAP BTP Cloud Foundry topology and HANA DB bindings
- 🔐 [`@saptools/cf-xsuaa`](https://www.npmjs.com/package/@saptools/cf-xsuaa) — fetch XSUAA credentials and cached OAuth2 tokens for CF apps
- 🗂️ [saptools monorepo](https://github.com/dongitran/saptools) — the full toolbox

---

## 👨‍💻 Author

**dongtran** ✨

## 📄 License

MIT

---

Made with ❤️ to make your work life easier!
