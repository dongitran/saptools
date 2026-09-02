// A minimal in-memory npm registry for the self-update e2e tests: the
// dist-tags endpoint the updater reads, the abbreviated packument npm reads,
// and the tarball npm downloads. Everything else is a 404, so a test can
// prove that a scenario made no network call at all by counting requests.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RegistryRequest {
  readonly method: string;
  readonly path: string;
  readonly userAgent: string;
}

export interface FakeRegistryOptions {
  readonly packageName: string;
  /** What `dist-tags.latest` reports. */
  latest: string;
  /** The tarball served for `latest`; without one npm's download 404s. */
  tarball?: Buffer;
  /** Override the dist-tags status to simulate a broken registry. */
  distTagsStatus?: number;
  /** Serve the tarball URL with this status instead of the bytes. */
  tarballStatus?: number;
}

export interface FakeRegistry {
  readonly url: string;
  readonly options: FakeRegistryOptions;
  readonly requests: RegistryRequest[];
  close(): Promise<void>;
}

export function tarballIntegrity(tarball: Buffer): { readonly shasum: string; readonly integrity: string } {
  return {
    shasum: createHash("sha1").update(tarball).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function packument(options: FakeRegistryOptions, url: string): unknown {
  const tarball = options.tarball ?? Buffer.alloc(0);
  const { shasum, integrity } = tarballIntegrity(tarball);
  const fileName = `${options.packageName.replace(/^@/, "").replace("/", "-")}-${options.latest}.tgz`;
  return {
    name: options.packageName,
    "dist-tags": { latest: options.latest },
    versions: {
      [options.latest]: {
        name: options.packageName,
        version: options.latest,
        type: "module",
        bin: { "cf-metrics": "dist/cli.js" },
        dist: { tarball: `${url}/tarballs/${fileName}`, shasum, integrity },
      },
    },
    modified: "2026-09-02T00:00:00.000Z",
  };
}

function handle(request: IncomingMessage, response: ServerResponse, options: FakeRegistryOptions, url: string, requests: RegistryRequest[]): void {
  const rawPath = (request.url ?? "/").split("?")[0] ?? "/";
  const path = decodeURIComponent(rawPath);
  requests.push({ method: request.method ?? "GET", path, userAgent: request.headers["user-agent"] ?? "" });

  if (path === `/-/package/${options.packageName}/dist-tags`) {
    json(response, options.distTagsStatus ?? 200, { latest: options.latest });
    return;
  }
  if (path === `/${options.packageName}`) {
    json(response, 200, packument(options, url));
    return;
  }
  if (path.startsWith("/tarballs/")) {
    if (options.tarball === undefined || options.tarballStatus !== undefined) {
      json(response, options.tarballStatus ?? 404, { error: "tarball not found" });
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(options.tarball.length) });
    response.end(options.tarball);
    return;
  }
  json(response, 404, { error: "Not found" });
}

export async function startFakeRegistry(options: FakeRegistryOptions): Promise<FakeRegistry> {
  const requests: RegistryRequest[] = [];
  let url = "";
  const server = createServer((request, response) => {
    handle(request, response, options, url, requests);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    url,
    options,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
