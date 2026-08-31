import { setTimeout as delayPromise } from "node:timers/promises";

import { DEFAULT_INDEX_PATTERN } from "./config.js";
import { errorMessage } from "./errors.js";
import type { OpenSearchClient, SearchHit, SearchResponse } from "./opensearch-client.js";
import { buildMetricBoolQuery, resolveTimeBound } from "./query-builder.js";

export interface WatchPollOptions {
  readonly service: string;
  readonly name?: string;
  readonly intervalMs: number;
  readonly lookback: string;
}

/**
 * One `_search` page's cap. Also the threshold past which a poll cycle may
 * be leaving newer, not-yet-fetched documents for the next cycle to catch up
 * on — see {@link watchMetrics}.
 */
export const WATCH_FETCH_LIMIT = 100;

/** Swallows the abort rejection so the caller's loop can re-check `signal.aborted` cleanly. */
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delayPromise(ms, undefined, { signal });
  } catch {
    // Aborted — resolve quietly, the loop's own `while (!signal.aborted)` handles it.
  }
}

/**
 * Filter `hits` (one poll's page, sorted ascending by `time`) down to the
 * ids not already in `seenAtCursor`, returning both the fresh subset (in the
 * same, already-chronological order) and the updated set.
 *
 * `seenAtCursor` only ever needs to hold ids tied to the *current* cursor's
 * exact timestamp: the `since: cursor` query filter is inclusive (`gte`), so
 * a boundary tie is the only case a document can be re-fetched on a later
 * poll — anything strictly newer than the cursor cannot repeat, and anything
 * strictly older is already excluded by the filter itself. Exported as a
 * standalone pure function so its bounded-growth property (see
 * {@link advanceCursor}) can be verified directly, without driving the full
 * async polling loop through many iterations.
 */
export function dedupeAgainstCursor(
  hits: readonly SearchHit[],
  seenAtCursor: ReadonlySet<string>,
): { readonly fresh: readonly SearchHit[]; readonly seenAtCursor: ReadonlySet<string> } {
  const nextSeen = new Set(seenAtCursor);
  const fresh: SearchHit[] = [];
  for (const hit of hits) {
    if (!nextSeen.has(hit._id)) {
      nextSeen.add(hit._id);
      fresh.push(hit);
    }
  }
  return { fresh, seenAtCursor: nextSeen };
}

/**
 * Decide the next poll's cursor from the page just fetched (ascending by
 * `time`): the last item *actually returned*, never "the newest document
 * that matched" — a page capped at {@link WATCH_FETCH_LIMIT} can leave newer
 * documents unfetched, and jumping the cursor past them would skip them
 * forever (see `watchMetrics`'s doc comment).
 *
 * When the cursor does move forward, the dedup set resets to only the ids
 * tied at the new cursor's exact timestamp — nothing older can be matched by
 * a future poll's `since: cursor` filter again, so remembering it further
 * would only let the set grow without bound over a long-running watch
 * session.
 */
export function advanceCursor(
  currentCursor: string,
  hits: readonly SearchHit[],
  seenAtCursor: ReadonlySet<string>,
): { readonly cursor: string; readonly seenAtCursor: ReadonlySet<string> } {
  const last = hits[hits.length - 1];
  const lastTime = last?._source["time"];
  if (typeof lastTime !== "string" || lastTime.length === 0 || lastTime === currentCursor) {
    return { cursor: currentCursor, seenAtCursor };
  }
  const tiedIds = hits.filter((hit) => hit._source["time"] === lastTime).map((hit) => hit._id);
  return { cursor: lastTime, seenAtCursor: new Set(tiedIds) };
}

/**
 * Poll `metrics-*` for documents newer than a rolling cursor, deduping by
 * document `_id` and calling `onPoint` for each newly-seen doc in
 * chronological order. Ported from `@saptools/cf-events`' `watchEvents` loop
 * shape (`delay`+`AbortSignal`, `Set`-based dedup, cursor-advance), with one
 * deliberate deviation from that port: cf-events advances its cursor to the
 * single newest matched item under a `desc` sort, which is safe there
 * because its event volume never approaches its own page cap in practice.
 * Metrics ingestion can burst well past {@link WATCH_FETCH_LIMIT} documents
 * between polls — under the `desc`+"jump to newest" approach, everything
 * below the top-N cutoff would be silently and *permanently* skipped (the
 * cursor jump lands past them, and the `since: cursor` filter then excludes
 * them forever). Sorting `asc` instead and advancing to the last item
 * actually returned (see {@link advanceCursor}) turns that worst case into
 * "delayed by one extra poll cycle": `onNotice`, when supplied, gets a
 * one-line notice whenever a page comes back exactly at the cap, since more
 * may still be waiting.
 *
 * A per-poll `client.search` failure (e.g. a transient network blip) is
 * caught and reported via `onNotice` rather than propagated — otherwise a
 * single hiccup would kill the whole watch session. Only a failure before
 * the loop starts (target/credential resolution, handled by the CLI layer
 * that calls this function) is still fatal, as before.
 */
export async function watchMetrics(
  client: OpenSearchClient,
  opts: WatchPollOptions,
  onPoint: (source: Readonly<Record<string, unknown>>) => void,
  signal: AbortSignal,
  onNotice?: (message: string) => void,
): Promise<void> {
  let cursor = resolveTimeBound(opts.lookback);
  let seenAtCursor: ReadonlySet<string> = new Set();

  while (!signal.aborted) {
    const query = buildMetricBoolQuery({
      service: opts.service,
      ...(opts.name === undefined ? {} : { names: [opts.name] }),
      since: cursor,
    });

    let response: SearchResponse;
    try {
      response = await client.search(
        DEFAULT_INDEX_PATTERN,
        { size: WATCH_FETCH_LIMIT, query, sort: [{ time: { order: "asc", unmapped_type: "date" } }] },
        signal,
      );
    } catch (error) {
      onNotice?.(`poll failed: ${errorMessage(error)}, retrying next interval`);
      await delay(opts.intervalMs, signal);
      continue;
    }

    const deduped = dedupeAgainstCursor(response.hits, seenAtCursor);
    for (const hit of deduped.fresh) {
      onPoint(hit._source);
    }
    if (response.hits.length === WATCH_FETCH_LIMIT) {
      onNotice?.(
        `${String(WATCH_FETCH_LIMIT)}+ new points this cycle, showing the oldest ${String(WATCH_FETCH_LIMIT)} — catching up next poll`,
      );
    }

    const advanced = advanceCursor(cursor, response.hits, deduped.seenAtCursor);
    cursor = advanced.cursor;
    seenAtCursor = advanced.seenAtCursor;

    await delay(opts.intervalMs, signal);
  }
}
