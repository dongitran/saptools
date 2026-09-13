import type { OpenSearchClient } from "@saptools/core";

import { DEFAULT_PIT_KEEP_ALIVE } from "./config.js";

export interface PitPage<TSource> {
  readonly hits: readonly { readonly id: string; readonly source: TSource }[];
  readonly totalHits: number;
  readonly truncated: boolean;
}

const SORT_TIEBREAKER = [{ "@timestamp": "desc" }, { _doc: "asc" }] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function openPit(client: OpenSearchClient, index: string, keepAlive: string): Promise<string> {
  const response = await client.raw(`${index}/_search/point_in_time?keep_alive=${encodeURIComponent(keepAlive)}`, "POST");
  const pitId = isRecord(response) ? response["pit_id"] : undefined;
  if (typeof pitId !== "string" || pitId.length === 0) {
    throw new Error(`OpenSearch did not return a pit_id when opening a Point-in-Time search on ${index}`);
  }
  return pitId;
}

async function closePit(client: OpenSearchClient, pitId: string): Promise<void> {
  try {
    await client.raw("_search/point_in_time", "DELETE", { pit_id: [pitId] });
  } catch {
    // Best effort: an unclosed PIT expires on its own after keep_alive elapses; a failed close must not fail the caller's query.
  }
}

/**
 * Fetch up to `maxTotal` hits for `query` against `index`, newest first,
 * using Point-in-Time + `search_after` — see this file's header comment and
 * the design doc for why `@saptools/core`'s `searchAfterAll` cannot be
 * reused for this index. The PIT is always closed, including on error.
 */
export async function pitSearchAll<TSource>(
  client: OpenSearchClient,
  index: string,
  query: Record<string, unknown>,
  pageSize: number,
  maxTotal: number,
  keepAlive: string = DEFAULT_PIT_KEEP_ALIVE,
): Promise<PitPage<TSource>> {
  const pitId = await openPit(client, index, keepAlive);
  try {
    const hits: { id: string; source: TSource }[] = [];
    let currentPitId = pitId;
    let searchAfter: readonly unknown[] | undefined;
    let totalHits = 0;

    for (;;) {
      const body: Record<string, unknown> = {
        size: pageSize,
        query,
        pit: { id: currentPitId, keep_alive: keepAlive },
        sort: SORT_TIEBREAKER,
        track_total_hits: true,
        ...(searchAfter === undefined ? {} : { search_after: searchAfter }),
      };
      const response = await client.raw("_search", "POST", body);
      if (!isRecord(response)) {
        throw new Error("OpenSearch returned an unexpected response shape for a Point-in-Time search");
      }
      const returnedPitId = response["pit_id"];
      if (typeof returnedPitId === "string" && returnedPitId.length > 0) {
        currentPitId = returnedPitId;
      }
      const hitsRecord = isRecord(response["hits"]) ? response["hits"] : undefined;
      const rawHitsValue: unknown = hitsRecord?.["hits"];
      const rawHits: readonly unknown[] = Array.isArray(rawHitsValue) ? rawHitsValue : [];
      const total = hitsRecord?.["total"];
      totalHits = isRecord(total) && typeof total["value"] === "number" ? total["value"] : totalHits;

      for (const raw of rawHits) {
        if (!isRecord(raw) || typeof raw["_id"] !== "string") {
          continue;
        }
        hits.push({ id: raw["_id"], source: raw["_source"] as TSource });
      }

      // Checked right after appending a page, not only between pages: a page
      // can itself carry `hits` past `maxTotal` (e.g. pageSize=2, maxTotal=3
      // — the second full page pushes the running total from 2 to 4), so the
      // slice below is required, not defensive-only.
      if (hits.length >= maxTotal) {
        return { hits: hits.slice(0, maxTotal), totalHits, truncated: true };
      }

      const last = rawHits[rawHits.length - 1];
      const lastSort = isRecord(last) ? last["sort"] : undefined;

      if (rawHits.length < pageSize || !Array.isArray(lastSort)) {
        return { hits, totalHits, truncated: hits.length < totalHits };
      }
      searchAfter = lastSort;
    }
  } finally {
    await closePit(client, pitId);
  }
}
