import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MONOREPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
export const CLI_PATH = join(PACKAGE_ROOT, "dist", "cli.js");

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Fixture {
  readonly root: string;
  readonly homeDir: string;
  readonly sourceBare: string;
  readonly destBare: string;
  readonly sourceCommits: readonly string[];
}

export interface FixtureOptions {
  readonly conflict?: boolean;
  readonly duplicate?: boolean;
}

export interface CreatedMrBody {
  readonly source_branch: string;
  readonly target_branch: string;
  readonly title: string;
  readonly description: string;
  readonly draft: boolean;
}

export interface FakeGitLab {
  readonly apiBase: string;
  readonly createdMergeRequests: readonly CreatedMrBody[];
  stop: () => Promise<void>;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function gitNoCwd(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function configureGit(cwd: string): Promise<void> {
  await git(cwd, ["config", "user.email", "author@example.com"]);
  await git(cwd, ["config", "user.name", "Source Author"]);
}

async function createSeedRepo(root: string): Promise<string> {
  const seed = join(root, "seed");
  await gitNoCwd(["init", "-b", "main", seed]);
  await configureGit(seed);
  await writeFile(join(seed, "app.txt"), "value=base\n", "utf8");
  await git(seed, ["add", "app.txt"]);
  await git(seed, ["commit", "-m", "base"]);
  return seed;
}

async function createSourceBranch(
  root: string,
  sourceBare: string,
  options: FixtureOptions,
): Promise<readonly string[]> {
  const work = join(root, "source-work");
  await gitNoCwd(["clone", sourceBare, work]);
  await configureGit(work);
  await git(work, ["checkout", "-b", "feature/gitport"]);
  if (options.conflict === true) {
    await writeFile(join(work, "app.txt"), "value=incoming\n", "utf8");
    await git(work, ["commit", "-am", "incoming conflict change"]);
  } else {
    await writeFile(join(work, "feature.txt"), "ported feature\n", "utf8");
    await git(work, ["add", "feature.txt"]);
    await git(work, ["commit", "-m", "add portable feature"]);
  }
  await git(work, ["push", "origin", "feature/gitport"]);
  const raw = await git(work, ["rev-list", "--reverse", "main..feature/gitport"]);
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
}

async function customizeDestination(
  root: string,
  destBare: string,
  options: FixtureOptions,
): Promise<void> {
  if (options.conflict !== true && options.duplicate !== true) {
    return;
  }
  const work = join(root, "dest-work");
  await gitNoCwd(["clone", destBare, work]);
  await configureGit(work);
  if (options.conflict === true) {
    await writeFile(join(work, "app.txt"), "value=old-destination\n", "utf8");
    await git(work, ["commit", "-am", "destination customization"]);
  } else {
    await writeFile(join(work, "feature.txt"), "ported feature\n", "utf8");
    await git(work, ["add", "feature.txt"]);
    await git(work, ["commit", "-m", "already ported patch"]);
  }
  await git(work, ["push", "origin", "main"]);
}

function normalizeFixtureOptions(input: boolean | FixtureOptions): FixtureOptions {
  return typeof input === "boolean" ? { conflict: input } : input;
}

export async function createFixture(input: boolean | FixtureOptions): Promise<Fixture> {
  const options = normalizeFixtureOptions(input);
  const root = await mkdtemp(join(tmpdir(), "gitport-e2e-"));
  const homeDir = join(root, "home");
  await mkdir(homeDir, { recursive: true });
  const seed = await createSeedRepo(root);
  const sourceBare = join(root, "repo-a.git");
  const destBare = join(root, "repo-b.git");
  await gitNoCwd(["clone", "--bare", seed, sourceBare]);
  await gitNoCwd(["clone", "--bare", seed, destBare]);
  const sourceCommits = await createSourceBranch(root, sourceBare, options);
  await customizeDestination(root, destBare, options);
  return { root, homeDir, sourceBare, destBare, sourceCommits };
}

export async function cleanupFixture(fixture: Fixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  await once(request, "end");
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length === 0 ? {} : (JSON.parse(raw) as unknown);
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function isCreatedMrBody(value: unknown): value is CreatedMrBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return (
    typeof record["source_branch"] === "string" &&
    typeof record["target_branch"] === "string" &&
    typeof record["title"] === "string" &&
    typeof record["description"] === "string" &&
    typeof record["draft"] === "boolean"
  );
}

async function handleFakeGitLabRequest(
  request: IncomingMessage,
  response: ServerResponse,
  fixture: Fixture,
  createdMergeRequests: CreatedMrBody[],
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/api/v4/projects/repo-a/merge_requests/123") {
    writeJson(response, 200, {
      iid: 123,
      title: "Source MR",
      source_branch: "feature/gitport",
      web_url: "http://127.0.0.1/repo-a/-/merge_requests/123",
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/v4/projects/repo-a/merge_requests/123/commits") {
    const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    const perPage = Number.parseInt(url.searchParams.get("per_page") ?? "100", 10);
    const start = (page - 1) * perPage;
    const values = fixture.sourceCommits.slice(start, start + perPage);
    const nextPage = start + perPage < fixture.sourceCommits.length ? (page + 1).toString() : "";
    writeJson(
      response,
      200,
      values.map((sha) => ({
        id: sha,
        title: sha === fixture.sourceCommits[0] ? "port change" : "extra change",
        message: "port change\n",
      })),
      { "x-next-page": nextPage },
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/v4/projects/repo-b/merge_requests") {
    const body = await readJsonBody(request);
    if (!isCreatedMrBody(body)) {
      writeJson(response, 400, { message: "invalid body" });
      return;
    }
    createdMergeRequests.push(body);
    writeJson(response, 201, {
      iid: 7,
      web_url: "http://127.0.0.1/repo-b/-/merge_requests/7",
      draft: true,
    });
    return;
  }
  writeJson(response, 404, { message: `No fake route for ${request.method ?? "GET"} ${url.pathname}` });
}

export async function startFakeGitLab(fixture: Fixture): Promise<FakeGitLab> {
  const createdMergeRequests: CreatedMrBody[] = [];
  const server: Server = createServer((request, response) => {
    void handleFakeGitLabRequest(request, response, fixture, createdMergeRequests).catch((error: unknown) => {
      writeJson(response, 500, { message: error instanceof Error ? error.message : String(error) });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Fake GitLab did not expose a TCP address");
  }
  return {
    apiBase: `http://127.0.0.1:${address.port.toString()}/api/v4`,
    createdMergeRequests,
    stop: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

export async function runCli(args: readonly string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return await new Promise<RunResult>((resolveResult, rejectResult) => {
    execFile("node", [CLI_PATH, ...args], { env, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) {
        resolveResult({ code: 0, stdout, stderr });
        return;
      }
      const code = typeof error.code === "number" ? error.code : 1;
      resolveResult({ code, stdout, stderr });
    }).on("error", rejectResult);
  });
}

export async function readBranchFile(
  bareRepo: string,
  branch: string,
  path: string,
): Promise<string> {
  const { stdout } = await execFileAsync("git", ["--git-dir", bareRepo, "show", `${branch}:${path}`]);
  return stdout;
}

export async function buildPackage(): Promise<void> {
  await execFileAsync("pnpm", ["--filter", "@saptools/gitport", "build"], {
    cwd: MONOREPO_ROOT,
    maxBuffer: 32 * 1024 * 1024,
  });
}

export async function readFileIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}
