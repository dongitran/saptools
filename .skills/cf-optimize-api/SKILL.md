---
name: cf-optimize-api
description: >-
  Use when tasked with analyzing, debugging, or optimizing the performance, latency, or database efficiency of an API, service endpoint, or background job on SAP BTP Cloud Foundry. Guides the agent through an end-to-end, multi-iteration loop: reproducing the request with cf-request-runner, querying OpenTelemetry traces via cf-otel to compute self-time bottlenecks, deep-diving with cf-hana/cf-function-trace, deciding between adding observability probes vs implementing code/DB optimizations, automating git branch/MR merging, monitoring CI/CD deployment pipelines, verifying CF instance health (running_instances == requested_instances), and proving latency reduction using cf-otel diff.
---

# CF Optimize API

## Purpose

`cf-optimize-api` is the master orchestration playbook for diagnosing and tuning API performance on SAP BTP Cloud Foundry. It replaces guesswork with an **observability-driven, iterative lifecycle**:
`Reproduce` ➔ `Query Trace` ➔ `Profile Self-Time` ➔ `Diagnose` ➔ `Implement Probes or Fix` ➔ `Branch/Commit/Push/Auto-merge MR` ➔ `Monitor CI/CD Pipeline` ➔ `Verify CF Health` ➔ `Diff Benchmark` ➔ `Iterate Until Target SLO Met`.

---

## Prerequisites & Required Toolchain

Ensure the following tools from `@saptools` are available:
- `cf-request-runner`: For executing deterministic test requests with auto XSUAA token injection.
- `cf-otel`: For querying OpenSearch spans, ranking self-time, and diffing before/after traces.
- `cf-hana`: For analyzing SQL queries, explain plans, and index structures on SAP HANA Cloud.
- `cf-logs`: For querying Cloud Logging / application logs for errors, memory warnings, and CPU spikes.
- `cf-inspector`: For inspecting Node.js heap usage, process memory, and live runtime state.
- `cf-explorer`: For discovering and exploring Cloud Foundry space topology, apps, routes, and service bindings.
- `cf-events`: For auditing Cloud Foundry container crash events, restart history, and lifecycle events.
- `cf` (Cloud Foundry CLI): For inspecting app state, instances, and live logs.
- `git` & `glab` / `gh`: For managing branches, commits, MR creation, and merge automation.

---

## The E2E Iterative Optimization Workflow

```
                               ┌──────────────────────────────────────────────┐
                               │        TARGET SLO & BUDGET DEFINITION        │
                               └──────────────────────┬───────────────────────┘
                                                      │
                                                      ▼
                        ┌────────────────────────────────────────────────────────────┐
                   ┌───►│             STEP 1: REPRODUCE & QUERY TRACE (N)            │
                   │    │  • Send test request via `cf-request-runner` (or `curl`)   │
                   │    │  • Measure actual response latency (L_N)                   │
                   │    │  • Query exact Trace ID (T_N) via `cf-otel find`           │
                   │    └─────────────────────────────┬──────────────────────────────┘
                   │                                  │
                   │                                  ▼
                   │    ┌────────────────────────────────────────────────────────────┐
                   │    │          STEP 2: PROFILE SELF-TIME & BOTTLENECKS           │
                   │    │  • Run `cf-otel selftime <T_N>`                            │
                   │    │  • Breakdown: Identify primary bottleneck in this cycle    │
                   │    │  • (HANA SQL query, JS CPU loop, Network downstream)       │
                   │    └─────────────────────────────┬──────────────────────────────┘
                   │                                  │
                   │                                  ▼
                   │                     /─────────────────────────\
                   │                    /     IS TARGET SLO MET     \      [TARGET SLO MET]
                   │                   <   OR BOTTLENECK RESOLVED?   > ──────────────────────┐
                   │                    \  (Latency <= target, OK?) /                        │
                   │                     \─────────────────────────/                         │
                   │                                  │ [UNMET - PROCEED TO FIX]             │
                   │                                  ▼                                      │
                   │                     /─────────────────────────\                         │
                   │                    /      IS ROOT CAUSE        \                        │
                   │                   <    CLEAR & ACTIONABLE?      >                       │
                   │                    \   (Black-box vs Known?)   /                        │
                   │                     \─────────────────────────/                         │
                   │                        │                     │                          │
                   │      [INSUFFICIENT DATA / BLACK BOX]         │ [CLEAR ROOT CAUSE KNOWN] │
                   │                        │                     │                          │
                   │                        ▼                     ▼                          │
                   │    ┌──────────────────────────────┐ ┌──────────────────────────────┐    │
                   │    │ 3A. IMPLEMENT OBSERVABILITY  │ │  3B. IMPLEMENT OPTIMIZATION  │    │
                   │    │ (Add Assessment Baselines)   │ │  (Implement Code/DB Fix)     │    │
                   │    │ • Add manual OTel spans      │ │ • Add database index @index  │    │
                   │    │ • Attach timers / metrics    │ │ • Batch queries (WHERE IN)   │    │
                   │    │ • Instrument deep functions  │ │ • Apply caching / pushdown   │    │
                   │    └──────────────┬───────────────┘ └──────────────┬───────────────┘    │
                   │                   │                                │                    │
                   │                   └───────────────┬────────────────┘                    │
                   │                                   │                                     │
                   │                                   ▼                                     │
                   │    ┌────────────────────────────────────────────────────────────┐       │
                   │    │           STEP 4: GIT BRANCH, PUSH & AUTO-MERGE MR         │       │
                   │    │  • Checkout branch `perf/optimize-<api>-iter-<N>`          │       │
                   │    │  • Commit, push & create auto-merge MR into target branch  │       │
                   │    └─────────────────────────────┬──────────────────────────────┘       │
                   │                                  │                                      │
                   │                                  ▼                                      │
                   │    ┌────────────────────────────────────────────────────────────┐       │
                   │    │              STEP 5: MONITOR CI/CD PIPELINE                │       │
                   │    │  • Poll build & deploy pipeline until Pass                 │       │
                   │    └─────────────────────────────┬──────────────────────────────┘       │
                   │                                  │                                      │
                   │                                  ▼                                      │
                   │    ┌────────────────────────────────────────────────────────────┐       │
                   │    │           STEP 6: CF SERVICES HEALTH CHECK                 │       │
                   │    │  • `cf app <name>` (running_instances == requested_inst)   │       │
                   │    │  • `cf-events` & `cf logs` (verify zero crashes/panics)    │       │
                   │    └─────────────────────────────┬──────────────────────────────┘       │
                   │                                  │                                      │
                   │                                  ▼                                      │
                   │    ┌────────────────────────────────────────────────────────────┐       │
                   │    │        STEP 7: TRACE DIFF & INCREMENT CYCLE (N = N+1)      │       │
                   │    │  • Run `cf-otel diff <T_N-1> <T_N>` to measure improvement │       │
                   │    │  • Record progress and increment cycle counter N = N + 1   │       │
                   │    └─────────────────────────────┬──────────────────────────────┘       │
                   │                                  │                                      │
                   └──────────────────────────────────┘                                      │
                                                                                             │
                                                                                             ▼
                                                              ┌──────────────────────────────────────────────┐
                                                              │    FINAL CONVERGENCE & VERIFICATION REPORT   │
                                                              │  • Progression matrix across cycles (T0->Tk) │
                                                              │  • Comprehensive log of applied fixes        │
                                                              │  • Trace diff proof confirming target SLO met│
                                                              └──────────────────────────────────────────────┘
```

### Flow Sequence Summary

1. **Setup & Target SLO Definition**: Define clear optimization goals (Target latency threshold, DB query budget) and initialize cycle counter $N = 1$ (maximum 5 cycles).
2. **Step 1: Reproduce & Query Trace ($N$)**: Execute a test request using `cf-request-runner` (or run a user-provided `curl` command), measure actual response latency $L_N$, and query OpenSearch via `cf-otel find --since 2m` to retrieve the exact freshly-generated Trace ID $T_N$.
3. **Step 2: Profile Self-Time & Bottlenecks**: Run `cf-otel selftime <T_N>` to breakdown the execution duration across layers: SAP HANA database operations, Node.js Event Loop / CPU processing, or downstream remote HTTP calls.
4. **Decision Gate 1 (SLO Gate)**:
   - If $L_N \le \text{Target SLO}$ and no anomalous spans remain ➔ Jump directly to **Final Convergence & Verification Report**.
   - If performance target is not yet met ➔ Proceed to Decision Gate 2.
5. **Decision Gate 2 (Information Adequacy Gate)**:
   - **Branch 3A (Insufficient Data / Black-box Span)**: Instrument code with OpenTelemetry sub-spans (`tracer.startSpan()`), metrics, or diagnostic logs to break down opaque logic into measurable units.
   - **Branch 3B (Clear Root Cause Established)**: Implement direct optimizations (Add `@index` in CDS models, batch queries using `WHERE IN (...)`, introduce caching, push down calculations to HANA Views).
6. **Step 4: Git Branch, Push & Auto-Merge MR**: Create a dedicated branch `perf/optimize-<api>-iter-<N>`, commit with a descriptive message, push to remote, and open an auto-merging Merge Request / Pull Request.
7. **Step 5: Monitor CI/CD Pipeline**: Poll the build and deployment pipeline until all stages succeed (`Pass`).
8. **Step 6: Cloud Foundry Services Health Check**: Inspect `cf app <name>` to verify that all requested instances are running (`running_instances == requested_instances`, i.e., $N/N$), audit `cf-events` for zero crash/restart anomalies, and inspect `cf logs <name> --recent` to confirm clean application boot.
9. **Step 7: Trace Diff & Cycle Increment ($N = N + 1$)**: Execute `cf-otel diff <T_{N-1}> <T_N>` to quantify performance gains for this cycle, increment $N = N + 1$, and **loop back to Step 1** to re-measure and tackle the next bottleneck layer.
10. **Final Phase**: When Target SLO is achieved, generate a progression matrix $T_0 \rightarrow T_1 \rightarrow \dots \rightarrow T_{\text{final}}$ and summarize the full architectural improvements.

---

## Detailed Step-by-Step Instructions

### Step 0: Target SLO Definition
Before touching any code, explicitly define:
1. Target Latency Threshold (e.g. `P95 < 200ms`).
2. Target Database Query Budget (e.g. `HANA queries <= 3`).
3. Set loop counter $N = 1$ (Maximum iterations: 5).

---

### Step 1: Reproduce API & Query Trace ID ($T_N$)
Never analyze old or ambiguous traces. Actively trigger a test request:
1. **Execute Request**:
   ```bash
   cf-request-runner --app <app-name> --url <endpoint-url> --json
   # Or using curl:
   curl -s -w "\nHTTP_CODE:%{http_code} TIME_TOTAL:%{time_total}s\n" -X GET "<url>" -H "Authorization: Bearer <token>"
   ```
2. **Obtain Exact Trace ID**:
   - Check response header `traceparent` or `x-trace-id`.
   - Alternatively, search OpenSearch via `cf-otel`:
     ```bash
     cf-otel find --service <service-name> --since 2m --limit 1
     ```
   - Record baseline latency $L_N$ and Trace ID $T_N$.

---

### Step 2: Self-Time Breakdown & Bottleneck Discovery
Compute the exact distribution of execution time:
```bash
cf-otel selftime <T_N>
```
Analyze the ranking:
- **Database Bound**: `@cap-js/hana - exec SELECT/UPDATE/DELETE` spans dominate (> 50% self-time). Check if identical queries repeat (N+1 pattern).
- **CPU / Handler Bound**: Top-level handler has large self-time (> 30%) with no database spans beneath it.
- **Detached / Async Latency**: If span durations don't sum up to root duration, check for orphan chains:
  ```bash
  cf-otel detached <T_N>
  cf-otel gaps <T_N> <parentSpanId>
  ```

---

### Gate 1: SLO Exit Evaluation
- If $L_N \le \text{Target SLO}$ AND all critical bottlenecks are resolved:
  - Jump directly to **Final Convergence Report**.
- Otherwise, proceed to **Gate 2**.

---

### Gate 2: Information Adequacy Check
Evaluate if the current trace pinpointed the exact lines of code:
- **Case A: Insufficient Data / Black-box Span** ➔ Proceed to **Step 3A**.
  *(E.g., A single monolithic span takes 1.5s with no child spans).*
- **Case B: Clear Root Cause & Actionable Fix** ➔ Proceed to **Step 3B**.
  *(E.g., Clear N+1 loop on `cds.outbox` or unindexed table scan on HANA).*

---

### Step 3A: Implement Observability Probes (Adding Assessment Baselines)
When facing a black-box, instrument the code before optimizing:
1. Add OpenTelemetry manual child spans around suspicious blocks:
   ```javascript
   const tracer = opentelemetry.trace.getTracer('custom-profiler');
   await tracer.startActiveSpan('sub_operation_name', async (span) => {
     try {
       await performHeavyLogic();
     } finally {
       span.end();
     }
   });
   ```
2. Add diagnostic timing or SQL tracing parameters.

---

### Step 3B: Implement Performance Optimization Fix
When the root cause is established:
1. **SAP HANA / CDS Model Level**:
   - Add `@index: [{ name: 'idx_field', element: 'field' }]` to frequently filtered columns.
   - Delegate heavy calculation to HANA Views / Pushdown calculation.
2. **Node.js / CAP Handler Level**:
   - Replace sequential loops `for (const item of items) await SELECT...` with a single batch `SELECT.from(...).where({ ID: { in: ids } })`.
   - Run parallel independent promises with `Promise.all()`.
3. **Caching**:
   - Cache static master data / configuration in memory (TTL) or Redis.
4. **Asynchronous Offloading**:
   - Defer non-critical side effects (e.g. audit logs, notifications) to `cds.outbox` or Solace Event Mesh.

---

### Step 4: Git Branch, Commit, Push & Auto-Merge MR
1. Create a dedicated branch:
   ```bash
   git checkout -b perf/optimize-<api>-iter-<N>
   ```
2. Commit with precise explanation:
   ```bash
   git commit -m "perf(iter-<N>): optimize <api> - <description of fix/probe>"
   git push -u origin perf/optimize-<api>-iter-<N>
   ```
3. Create Merge Request and auto-merge:
   ```bash
   glab mr create --title "perf: optimize <api> (iter <N>)" --fill --yes --auto-merge
   # Or via GitHub CLI:
   gh pr create --title "perf: optimize <api> (iter <N>)" --fill && gh pr merge --auto --squash
   ```

---

### Step 5: Monitor CI/CD Pipeline
Poll the pipeline until the build, container image creation, and deployment finish successfully:
```bash
glab pipeline status --watch || gh run watch
```
If the pipeline fails, inspect logs, fix syntax/lint/test errors on the branch, and push again. Never merge broken builds.

---

### Step 6: Cloud Foundry Runtime Health Check
Verify that all requested instances are running stably:
1. **Instance Count Verification**:
   ```bash
   cf app <app-name>
   ```
   **Mandatory check**: `running_instances == requested_instances` (e.g. `instances: 2/2`, `web:2/2`). Ensure no instance index is in `crashed`, `starting`, or `down` state.
2. **Crash & Lifecycle Event Audit**:
   ```bash
   cf-events --app <app-name>
   ```
   Verify zero `app.crash` or abnormal exit events following the deployment.
3. **Log Audit**:
   ```bash
   cf logs <app-name> --recent
   ```
   Confirm zero uncaught exceptions, HANA connection timeouts, or OOM crashes on startup.

---

### Step 7: Trace Diff & Multi-Iteration Feedback Loop
1. Run `cf-otel diff` to benchmark the current iteration against the previous baseline:
   ```bash
   cf-otel diff <T_{N-1}> <T_N>
   ```
2. Log the percentage reduction in latency, database span self-time, and query counts.
3. Increment iteration counter: $N = N + 1$.
4. **Loop back to Step 1**: Re-run the reproduction request to measure the next layer of bottlenecks!

---

### Final Phase: Convergence & Verification Report
When the Target SLO is achieved or no further significant bottlenecks exist, publish a final summary:
- **Progression Matrix**: Table showing $T_0 \rightarrow T_1 \rightarrow \dots \rightarrow T_{\text{final}}$ (Latency, DB queries, Handler Self-Time).
- **Summary of Implemented Fixes**: Concise catalog of indexes added, queries batched, and probes installed.
- **Verification Evidence**: Proof from `cf-otel diff` confirming the API is fully stabilized and performant.

---

## Anti-Patterns & Guardrails

- **NEVER Guess Without Traces**: Always run Step 1 (`cf-request-runner` + `cf-otel find`) to have concrete empirical trace evidence before altering logic.
- **NEVER Skip Health Checks**: A successful pipeline does not guarantee a healthy container. Always verify `running_instances == requested_instances` in Step 6.
- **NEVER Assume a Single Fix Solves Everything**: Performance optimization is iterative ("peeling the onion"). Fixing a database bottleneck often exposes an application-layer bottleneck. Follow the loop until the overall SLO is met.
