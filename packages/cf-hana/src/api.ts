import { HanaClient } from "./client.js";
import type {
  ConnectOptions,
  QueryOptions,
  QueryResult,
  QueryRow,
  SqlParam,
} from "./types.js";

/**
 * Open a reusable, pooled client for the HANA database bound to a Cloud Foundry
 * app, addressed by a `region/org/space/app` selector or a bare app name.
 */
export async function connect(
  selector: string,
  options?: ConnectOptions,
): Promise<HanaClient> {
  return await HanaClient.connect(selector, options);
}

/**
 * Connect, run a single query, and close — the one-shot convenience for scripts.
 */
export async function query<TRow = QueryRow>(
  selector: string,
  sql: string,
  params?: readonly SqlParam[],
  options?: ConnectOptions & QueryOptions,
): Promise<QueryResult<TRow>> {
  const client = await HanaClient.connect(selector, options);
  try {
    return await client.query<TRow>(sql, params, options);
  } finally {
    await client.close();
  }
}

/** Run `work` with a client that is closed automatically afterwards. */
export async function withConnection<T>(
  selector: string,
  work: (client: HanaClient) => Promise<T>,
  options?: ConnectOptions,
): Promise<T> {
  const client = await HanaClient.connect(selector, options);
  try {
    return await work(client);
  } finally {
    await client.close();
  }
}
