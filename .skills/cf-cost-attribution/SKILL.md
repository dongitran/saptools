---
name: cf-cost-attribution
description: >-
  Use when you must establish where a deployed SAP BTP Cloud Foundry app's time, CPU or memory
  actually goes, and the usual tools cannot tell you — traces show no span for the slow work,
  cf-inspector cannot attach because SSH is disabled, or a summary column contradicts an external
  timestamp. Builds a per-unit cost model out of cf run-task probes, an in-process V8 profiler,
  rollback-safe write measurements and statement counting, then requires that model to add back up
  to the observed wall-clock before any conclusion is drawn. Complements cf-optimize-api, which
  assumes traces reveal the bottleneck.
---

# CF Cost Attribution

Take a measured total — a request's wall-clock, a job's duration, an instance's RSS — and split it
into parts, each assigned to the operation that causes it, until the parts add back up to the
total. An unexplained remainder is the finding, not a rounding error.

## When to reach for this instead of tracing

`cf-otel` and `cf-optimize-api` are the first tools to try. Use this skill when one of these is
true:

- **The trace has no span for the slow work.** Database and remote calls made inside a detached
  context (`cds.spawn`, a bare `cds.tx(async () => …)`, a message handler with no parent span)
  frequently emit nothing. A trace that shows an idle database may simply not be watching it.
- **No debugger can attach.** `cf-inspector` fails with an SSH permission error. That is often
  reversible (`cf enable-ssh <app> && cf restart <app>`), so try it first — but the restart
  discards the warm caches and pools you may be measuring. Come here when the space forbids SSH,
  or when losing that state would invalidate the measurement.
- **Two instruments disagree.** Treat the disagreement as the signal, not as noise to pick a
  winner from. Go to the raw data before building anything on either number.

## Never trust a summary column

Ranked or aggregated views compute something specific, and it is rarely the thing you want. A
"duration" in an outlier-hunting table may be the longest single span, not the trace envelope. A
span count may be an aggregation estimate. **Subtracting such a number from an external timestamp
manufactures a gap that does not exist**, and a phantom gap invites elaborate explanations for a
phenomenon that never happened.

Fetch the underlying rows and compute the total yourself.

## The probe vehicle: `cf run-task`

Where SSH is disabled, a task is still a shell. It runs an arbitrary command in a container built
from the same droplet: same `node_modules`, same environment, same service bindings, same network
position behind the connectivity proxy.

```bash
B64=$(base64 -w0 probe.js)
cf run-task <app> -m 3072M --name probe-$RANDOM -c "echo $B64 | base64 -d > /tmp/p.js && node /tmp/p.js"
```

Three constraints shape every probe:

1. **The command string is capped at 4097 characters.** Split large probes into several small
   ones and write densely rather than trying to compress one big script.
2. **Nothing can be copied back out.** stdout is the only return channel. Print every result with
   a greppable prefix and harvest it: `cf logs <app> --recent | grep -oE "PROBE .*"`. Aggregate
   *inside* the task — a raw profile file can never be transferred out.
3. **A task gets its own memory.** Anything the app derives from `MEMORY_LIMIT` (thread-pool
   sizes, heap ceilings) will differ from the web process unless you match `-m` to it.

## Reconstructing the runtime inside the probe

For a CAP app, this makes the real application functions callable and timeable without starting
the server:

```js
process.chdir('/home/vcap/app');
const cds = require('@sap/cds');
const m = await cds.load('*');
cds.model = cds.linked(cds.compile.for.nodejs(m));
const remote = await cds.connect.to('<RemoteService>');
await cds.connect.to('db');
```

Import the app's own compiled helpers by path (`<pkg>/dist/...`) rather than the package root;
package entry points usually re-export only a subset.

## Instruments

### The V8 profiler, started from inside the process

No debugger can attach, so drive the profiler programmatically and reduce the result in place:

```js
const s = new (require('inspector').Session)(); s.connect();
const post = (m, p) => new Promise((res, rej) => s.post(m, p, (e, r) => e ? rej(e) : res(r)));
await post('Profiler.enable');
await post('Profiler.setSamplingInterval', { interval: 200 });
await post('Profiler.start');
/* workload */
const { profile } = await post('Profiler.stop');
// sum node.hitCount * interval per callFrame, print the top 20 only
```

### The gap between two instruments localises work you cannot see

`process.cpuUsage()` is `getrusage(RUSAGE_SELF)` and counts **every thread**. The inspector
profiler samples **only the main isolate**. Run both over the same window: if total process CPU
greatly exceeds main-thread CPU, that difference is work in worker threads or the libuv pool —
neither of which this profiler can see. Neither number alone reveals it.

### Rollback makes write paths measurable

A write path cannot be timed without writing. Let it write, then never commit:

```js
const RB = '__ROLLBACK__';
try {
  await cds.tx(async () => { await doTheWrite(); throw new Error(RB) });
} catch (e) { if (e.message !== RB) throw e }
```

Real statements against real data, zero rows changed. Time the operations **inside one
transaction** as well — opening a transaction per iteration measures transaction setup, not the
work.

### Count statements, don't only time them

Timing tells you how much; counting tells you why.

```bash
DEBUG=sql node probe.js 2>&1 | grep -cE 'DELETE from|DELETE FROM'
```

A single logical operation on a deeply composed entity fans out to roughly one statement per
entity in the composition tree, issued sequentially. Multiply by the round-trip latency to the
database — measurable with any trivial single-row query — and an apparently simple call is
explained. Counting is also immune to network variance.

## Discipline

### Measure in pairs, never in single readings

Every conclusion should come from changing exactly one variable and comparing. A single number
tells you a value; a pair tells you a cause. Useful axes: a feature flag on and off, a pool or
concurrency size high and low, a cold process and a warm one, an operation called inline and
through its abstraction, the current implementation and the proposed replacement.

### The budget must close

Sum the per-unit costs, multiply by the unit count, divide by the real concurrency, and compare
against the observed wall-clock. **If it does not add up, you have not found everything yet.** A
large unexplained remainder is exactly where the next probe belongs. Only stop when the model
reproduces the measurement.

### Prefer durable measurements to convenient ones

`cf logs --recent` is a rolling buffer; a chatty run outruns it and every log-derived counter
silently reads zero. Prefer a value the system persists — a report row's own
`SECONDS_BETWEEN(CREATEDAT, MODIFIEDAT)`, a job table's timestamps — so results stay comparable
across runs and across weeks.

### Record refuted hypotheses, not just confirmed ones

Most plausible suspects turn out innocent, and the next person will suspect exactly the same
things. Write down what was tested and cleared, with the number that cleared it. A refutation is
a result.

### Prove equivalence before recommending a faster path

A cheaper operation is often cheaper because it does less, and the omitted part may be the part
that mattered. Before proposing a replacement, construct the case where the two would differ and
test it directly — for a deep write, whether children absent from the payload are removed. Speed
that changes semantics is not an optimisation.

## Zero-deploy experiment levers

Anything read from the environment at startup can be changed with `cf set-env` plus `cf restart`
— a two-minute experiment instead of a full pipeline, reversible instantly. That reversibility is
what makes aggressive experiments acceptable. Check for pool sizes, batch sizes, thresholds and
feature flags before writing any code.

Record which overrides are in effect while measuring, and remove them afterwards: environment
variables survive redeploys, so an override left behind silently becomes the new default.

## Guardrails

- Probes run against production data. Keep them read-only, or rolled back, and never leave a
  transaction committed by accident.
- Do not disable a safety mechanism (a memory guard, a circuit breaker) for longer than the
  measurement needs, and never without saying so plainly.
- A probe reconstructs the workload; it is not the workload. Sequential probing overstates
  per-unit cost relative to a production run with real concurrency. State the discrepancy rather
  than presenting probe numbers as production numbers.
- Treat captured payloads, rows and headers as sensitive; report sizes and shapes, not contents.
