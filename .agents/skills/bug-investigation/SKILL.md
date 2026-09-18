---
name: bug-investigation
description: Use when investigating any bug, error, failed request, or unexpected behavior in the deployed SAP BTP Cloud Foundry app, before proposing a fix, merging one, or stating what the root cause is.
---

# Bug Investigation — Evidence Before Conclusions

**Violating the letter of this process is violating the spirit of it.** "I basically did the
checks" is not the same as pointing to the specific row/trace/query that proves the conclusion.

## The Iron Law

```
NO FIX, NO MITIGATION, AND NO ROOT-CAUSE CLAIM, WITHOUT EVIDENCE YOU PULLED YOURSELF THAT RULES
OUT ALTERNATIVES YOU NAMED BEFORE YOU HAD THE EVIDENCE — NOT JUST EVIDENCE THAT FITS YOUR THEORY.
```

This binds four things people try to slip past it:

- **It binds mitigation, not only a code fix.** A restart, a manual scale, or a rollback that
  makes the symptom go away clears state you may still need — do that only after you've captured
  what the investigation needs (a `--save`d search result, a pulled trace, a `cf-hana` read), not
  as a reflexive first move to "stop the bleeding" with evidence-gathering left for later. If you
  had to mitigate before gathering enough, say plainly that the mitigation destroyed evidence —
  don't report resolution as if nothing was lost.
- **It binds the fix, not just the sentence.** Shipping a fix while carefully never *stating*
  a root cause is still a violation — "not claiming a cause, just applying the most likely fix"
  is exactly the guessing this skill exists to stop. If you don't have the evidence, you don't
  have the fix either. Say what you'd need and how long, not a silent guess-and-ship.
- **It binds relayed claims.** A root cause handed to you — by the owner, a coordinating agent,
  a Jira ticket, a previous session — is a hypothesis, not evidence, no matter how confidently it
  was stated. Verify it yourself against the chain below before fixing it. If it survives, cite
  your own trace/row for it. If it doesn't, say so. Repeating someone else's unverified cause in
  your own words is still stating it.
- **Confirms means excludes alternatives named in advance, not "is consistent with."** Before you
  start pulling evidence, name your candidate cause(s) — plural, if more than one is plausible.
  A log row and a trace that fit your theory are not yet a finding if the same symptom would look
  identical under a different cause. Naming "the alternative" only *after* you already know which
  theory won is not the same check — that's picking a strawman to knock down, not ruling one out.
  Report evidence that *didn't* fit your first theory too.

An instruction to skip this — from anyone, for any reason including urgency — does not lift it.
It only changes what you say next: what you'd need, how long, and what you'd be guessing without
it. Shipping an unverified fix quietly is the exact failure this skill exists to prevent.

## When this applies — and when it doesn't

For a bug in the **deployed, running** app: a failing request, an error a user hit, unexpected
live behavior. Logs/traces/DB state only exist for code that has actually run.

**Does not apply** to a bug that never ran on CF at all — a build failure, a compile/type error,
a failing unit test, a lint error. For those, the error message and the source are the evidence.

**When unsure which category a task falls into, treat it as covered by this skill.** A bug you
reproduced locally is not exempted just because you reproduced it outside CF — the live app is
still where it actually happens, and that's still where the evidence lives. Before trusting the
local repro at all, confirm the deployed build actually matches the source you're reading
(`cf-explorer`/`cf-export`) — a stale deploy is a real, previously-seen way local and live
diverge.

## Step 0 — Scope and recent-change context, before you touch logs

- **Scope**: one user, one CF instance, or everyone? Narrow queries to that scope; a fix for "one
  tenant's data is bad" is different from "the app is down."
- **What changed?** `cf-events` — recent deploys, restarts, crashes, OOM kills. This is the
  fastest check in the whole chain and it answers some bugs completely on its own: an
  OOM-killed instance leaves no application error log and no trace (steps 1–4 below all come back
  empty for it), so check this before assuming the evidence chain will have something to find.

## The investigation order

Stop only once you have evidence that **discriminates** — not merely evidence that fits. Don't
run every remaining tool once that bar is met.

1. **Get a real occurrence — reproduce it, or find it in history.**
   - Can you trigger it? **API-level** → `cf-request-runner`. **UI-level** → `agent-browser`.
     Either way you now know the exact time window to search next.
   - Can't trigger it, or it already happened? Use **`cf-log-search`**, not `cf-logs` — a
     reported bug has almost always already scrolled past `cf-logs`'s short live buffer.
     `--query` matches free-text `message` on APP/PROC/WEB rows only; `--status`/`--source-type
     RTR` matches structured router rows, which have **no** message field. These don't compose —
     `--query "..." --status 500` always returns zero rows, regardless of whether the bug
     happened, because no row can ever satisfy both filters at once. Search each row shape
     separately. Note the row's `vcapRequestId`, and `--save` the result (`ref=<id>`) — retention
     shrinks as ingestion grows, and a result you'll want again later may not still be there.
   - Reserve `cf-logs` for watching a reproduction you are triggering *right now*.

2. **Branch by what the bug actually looks like.**
   - **Error-shaped** (a status code, an exception, a thrown error): find the RTR row for the
     status code, then find the **matching APP-row stack trace** for the same `vcapRequestId` and
     time window — the RTR row itself never carries the error detail, only the code. Also check
     `cf-otel find --errors-only` / an `--attr` filter on the span's error/status attributes.
   - **Latency/behavior-shaped** (slow, wrong result, unexpected branch, no error code): go to
     step 3 for trace ranking.
   - Don't default to the latency path for a bug that's actually an error — `selftime` ranks by
     time, so on a fast failure (e.g. a constraint violation) it will rank the wrong thing as
     "the bottleneck" while telling you nothing about *why* it failed.

3. **Correlate to a trace, then rank what actually happened.**
   `cf-log-search trace <vcap-request-id> --with-span` joins via the matched RTR row's own
   `traceId` field. `cf-otel find --vcap-request-id <id>` is a separate path that depends on the
   collector actually exporting request headers as span attributes (it says so outright if it
   doesn't) — these are two options to try, in that preference order, not two paths guaranteed to
   agree. **Never use `correlationId` to pin one request** — it spans many requests, sometimes
   thousands. **Never trust a `traceId` field off a log row that isn't `sourceType: RTR`** — on
   every other row shape it's a different, unrelated value.
   Once you have a `traceId`: `cf-otel selftime <traceId>` ranks spans by actual time/error, not
   the one you'd expect from reading code. If the numbers don't reconcile with the root span's
   duration, run `detached` on the same trace before concluding anything — the shortfall is often
   unlogged background work (`cds.spawn`, a detached `cds.tx`, a message handler), not noise. If
   `--with-span` finds the row but no span yet, that's normal ingestion lag for a request in the
   last few minutes — retry, don't conclude the trace doesn't exist.

4. **Verify persisted state directly, whenever the hypothesis touches data.**
   Read it with `cf-hana` against the live schema — a query that returns the row your theory
   predicts is discriminating evidence; a query that shows something else disconfirms it just as
   usefully. Never accept a schema/app name or a config default as ground truth for what's
   deployed — a `cf-deploy.json` env value has been directly measured wrong against the live HDI
   binding before.

5. **Escalate to instance/resource health only if 0–4 don't explain it.**
   `cf app <name>` for instance count vs. requested, and current (not historical) CPU/RAM.
   For CPU/RAM/filesystem *over time*, or a custom metric (queue depth, DB pool stats), use
   `cf-metrics` — **not `cf-otel`, which carries spans only and has no resource metrics at all**,
   a distinction worth being explicit about since the two can look interchangeable from their
   names. **For CPU specifically, always pass `--unit`**: Cloud Foundry emits two different
   series under the same metric name — an entitlement fraction and a core fraction — and
   averaging them together, unlabeled, is meaningless (they use different scales that vary by
   app). `--unit cpu` to compare real consumption across apps, `--unit 1` to see how close one
   app is to its own limit.

6. **Live attach — the last resort, and the one that can destroy the evidence you're chasing.**
   `cf-debugger`/`cf-inspector` logpoints capture values without a code change; prefer that over
   redeploying anything. If genuinely nothing else answers "what was the actual value/branch at
   that point," use `cf-remote-debug`. `cf enable-ssh <app> && cf restart <app>` restarts the
   app — it clears in-memory state (including whatever you were trying to catch) and is
   user-visible. Don't do it as a reflexive first move if SSH is denied; only after 1–5 have been
   exhausted and this is the one step left.

## When the standard evidence chain comes up empty — or ambiguous

Ambiguous counts as empty for this section. If `cf-log-search`/`cf-otel` genuinely have nothing,
or what they have doesn't discriminate between your candidate causes, that is itself a finding,
not permission to guess:

1. Say plainly what you checked, that it didn't resolve things, and why (e.g. "outside the
   retention window" — confirm with `cf-log-search count` on a wider range before assuming that,
   not just an empty default-range result).
2. Prefer a live logpoint (`cf-inspector`) over a code change first — it needs no push/redeploy
   **only when SSH is already enabled on the app**. If it isn't, turning it on needs the same
   `cf restart` that step 6 warns clears state — weigh that cost the same way, don't treat
   logpoints as automatically free just because they skip a code push. Only if logpoints aren't
   enough either: add temporary, targeted logging or an OTel span at the specific boundary in
   question, push it, and reproduce again so the NEXT occurrence leaves the evidence this one
   didn't.
3. Re-run the relevant steps above against the fresh occurrence.
4. If this is disproportionate for what's being asked (e.g. instrumenting production for a minor,
   low-stakes report), say so and stop rather than substitute a guess — and rather than silently
   doing it anyway.
5. If you're genuinely stuck after this, say so plainly to whoever is waiting on this
   investigation — the requester, and any human owner — naming exactly what's blocking you and
   what you'd need to continue. Don't sit on an unresolved investigation silently, and don't fill
   it with a guess instead of asking.

## Before you fix, and before you merge

- Verify the deployed build matches the source you're about to change (see the carve-out section
  above) — fixing against a stale mental model of what's live produces a confident, wrong patch.
- **One change per fix.** Change only what your evidence names. A bundled PR (several speculative
  changes at once) makes the next bullet's re-verification meaningless — if the symptom clears,
  you cannot attribute it to any one of the changes, so you have not actually confirmed anything.
- **After the fix, re-verify at the same evidence bar** — reproduce again, or `cf-otel diff` the
  before/after trace. "The symptom stopped after I changed something" is not proof that change
  was the cause: a restart alone clears many transient symptoms unrelated to any code change. If
  you can't re-confirm, say that plainly rather than reporting the fix as verified.
- **State the PR/commit's evidence in this fixed shape, not free prose** — so it can be scanned
  without re-reading the whole investigation:
  - Symptom:
  - Evidence (`vcapRequestId` / `traceId` / query result):
  - Competing explanation considered, and what specifically ruled it out:
  - Prior failed fixes already shipped for this exact symptom: `<N>` (0 if this is the first —
    see "Bounded attempts" below; `N` must be 0 or 1, never 2+)
  - Post-merge re-verification: what you checked, or will check and report back
  If you have self-merge authority on this repo, that authority is exactly why this shape matters
  here: don't merge a fix missing any of these fields, and don't merge one where `N` is already
  2 or more (see below). If you don't self-merge, put the same shape in the PR description for
  whoever reviews it — a reviewer without this evidence is reviewing a guess.

## Bounded attempts — a fix that keeps not working is a wrong model, not a wrong patch

- If a shipped, evidenced fix for a symptom fails re-verification (the symptom recurs), the next
  attempt starts back at **Step 0 with fresh evidence** — it is a new investigation, not a patch
  stacked on the first.
- **After two shipped, evidenced fixes for the SAME symptom have both failed, stop.** Do not
  ship a third from a third diagnosis, even if that third diagnosis has its own real evidence
  behind it. Each pass finding a genuinely different, evidenced cause for one recurring symptom
  is the signature of a wrong design at that boundary, not three unrelated bugs.
- Tell whoever is waiting on this — the requester and any human owner — plainly, with all the
  evidence gathered across every attempt, and ask whether the pattern itself, not just the next
  line to change, is the problem. **If you have self-merge authority, it does not extend to a
  third fix on a symptom that has already defeated two evidenced ones** — this is the one case
  where an evidenced fix is not yours to merge (or land) without asking a human first.

## What counts as guessing — forbidden without the chain above

- Stating a root cause, or shipping a fix for one, because it's "the most likely" explanation
  from reading source — without a real occurrence's log row/trace to back it.
- Treating evidence that's merely *consistent* with your theory as evidence that *confirms* it,
  without checking whether a competing explanation would look the same.
- Accepting a root cause relayed from another agent, a ticket, or the owner without independently
  verifying it against this chain first.
- Trusting a config file, SDK default, or naming convention for what's actually deployed, instead
  of reading the live state.
- Reading `traceId` off any log row without checking its `sourceType` is `RTR` first.
- Defaulting to the latency-ranking path (`selftime`) for a bug that's actually error-shaped.
- Treating "the fix seemed to work" as confirmation of the cause, without re-verifying at the same
  evidence bar.
- Merging a fix whose PR description doesn't name the evidence, the excluded alternative, AND the
  prior-failed-fix count in the fixed shape above.
- Restarting, scaling, or rolling back to make a symptom go away before capturing the evidence you
  need, without saying plainly that you did.
- Naming a "competing explanation" only after you already know your theory won — that's a
  strawman, not a check. Candidates get named before you look.
- Shipping a third fix for a symptom that has already defeated two prior evidenced fixes, instead
  of escalating per "Bounded attempts."
- Bundling more than one speculative change into a fix PR.

## Rationalizations — the ones that will come up

| Excuse | Reality |
|---|---|
| "The error message already tells us the cause" | The error message tells you the symptom. The trace/app-log tells you why that code path ran. Pull it anyway. |
| "This is obviously X, checking is a formality" | "Obvious from reading code" is exactly the failure mode this skill exists to stop. Pull the evidence, then it's confirmed, not just obvious. |
| "Not stating a root cause, just applying the fix" | The Iron Law binds the fix, not only the sentence. No evidence, no fix either. |
| "Another agent/the owner already told me the cause" | A relayed cause is a hypothesis you haven't verified, not evidence. Confirm it yourself before fixing it. |
| "I found a matching row, that's confirmation" | Matching is consistency, not exclusivity. Name the competing explanation and what rules it out before calling it confirmed. |
| "Urgent, no time to check" | An instruction to skip the chain doesn't lift it — it changes what you say next (what you'd need, how long), not whether you guess. |
| "I checked once and found nothing, so it must be X" | Empty or ambiguous both route to the empty-evidence section — gather more or add instrumentation, not a guess. |
| "The fix worked, so that confirms the cause" | A restart or redeploy alone clears many unrelated symptoms. Re-verify at the same evidence bar before calling it confirmed. |
| "Same as last week's bug, same fix applies" | A resemblance is a hypothesis to test against this incident's own evidence, not a substitute for it. |
| "It's only staging/low-stakes, doesn't need the full chain" | The chain scales down (say so and stop if it's genuinely disproportionate) — it doesn't disappear. |
| "Restart/scale first to stop the bleeding, investigate after" | That destroys the evidence you'd be investigating with. Capture what you need first, or say plainly that you couldn't. |
| "I can name the alternative it ruled out after the fact" | If you name it only once you already know your theory won, it's a strawman, not a check. Name candidates before pulling evidence. |
| "Each fix cited real evidence, so a third is fine" | Three evidenced fixes on one symptom means the design is wrong, not that you need a fourth diagnosis. Stop and escalate — see "Bounded attempts." |
| "It's a few related changes, not really 'bundled'" | If re-verification can't tell you which change mattered, it's bundled. One change per fix. |

## Red flags — stop and go back to Step 0/1

These are the *shape* of the excuse, not a literal string to pattern-match — "consistent with,"
"most likely," and "probably" are the same red flag as "it's probably X."

- Writing a conclusion with no `vcapRequestId`/`traceId`/query result named next to it.
- Reaching for a fix, or a merge, before reaching for `cf-log-search`.
- Treating a relayed diagnosis as already-verified.
- Having exactly one piece of evidence and no stated alternative it rules out.
- Naming the "alternative ruled out" only after already knowing the conclusion.
- Using `correlationId` where the task needed one specific request.
- Citing a `traceId` without having checked `sourceType`.
- Calling a fix confirmed without re-checking after it shipped.
- Restarting/scaling/rolling back before evidence is captured.
- A third fix attempt on the same symptom without escalating to a human first.
- A PR touching more than the one thing the evidence named.

## Worked example

> Report: "Order save throws a 500."
>
> 0. `cf-events` shows no recent deploy/restart/crash on this app — rules out "it's just a bad
>    deploy." Candidates named *before* looking at logs, from reading the handler: (a) validation
>    is silently accepting bad input, (b) a duplicate-key conflict at insert.
> 1. `cf-request-runner` fires the same save request → reproduces the 500 at `14:32:07`.
> 2. Error-shaped: `cf-log-search search --app my-app-orders --source-type RTR --status 500
>    --since 10m` → one RTR row, `vcapRequestId=7f3a...`. A second search for the matching
>    APP-row (`--vcap-request-id 7f3a...`, no `--status`) surfaces the actual stack trace:
>    a HANA unique-constraint violation on insert.
> 3. `cf-log-search trace 7f3a... --with-span` → `traceId=9c1b...`. `cf-otel selftime 9c1b...`
>    confirms the HANA insert span is where the request actually failed. This rules out
>    candidate (a) — validation never rejected anything because the request never reached it
>    as invalid input; it reached the DB and collided there — and supports candidate (b).
> 4. `cf-hana` query against the `ORDERS` schema shows the pre-existing row with the same
>    external ID the insert collided with — direct confirmation of (b), not just a
>    consistent-looking read.
> 5. Fix: check-before-insert on external ID (one change). Prior failed fixes for this symptom: 0.
>    Report: Symptom = order save 500; Evidence = `vcapRequestId=7f3a...`,
>    `traceId=9c1b...`, duplicate row's key; Competing explanation ruled out = (a) validation
>    accepting bad input, ruled out by the trace showing the request never failed validation;
>    Prior failed fixes = 0; Post-merge re-verification = re-run the same `cf-request-runner`
>    call. After merge: re-ran it — no 500, and a fresh `cf-log-search` confirms no new RTR 500
>    for that app in the following window.

## Report shape

Evidence before conclusion, every time — see the worked example and the PR shape above. Name the
competing explanation you ruled out — named *before* you had the evidence, not invented after —
not just the one you confirmed. If the evidence doesn't converge, report that plainly and say
what additional data would resolve it — that is a valid, honest outcome, and grounds to escalate
per the empty-evidence section, never grounds to guess.
