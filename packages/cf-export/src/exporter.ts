import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ensureSshEnabled } from "./cf.js";
import { fetchDefaultEnvJson } from "./default-env.js";
import { fetchRemoteTextFile } from "./remote-paths.js";
import { openCfSession } from "./session.js";
import type { OpenCfSession } from "./session.js";
import { ARTIFACT_NAMES, type ArtifactName, type CfExecContext, type ExportArtifactsOptions, type ExportArtifactsResult } from "./types.js";

function resolveAllArtifacts(): readonly ArtifactName[] {
  return [...ARTIFACT_NAMES];
}

function normalizeRequested(requested: readonly ArtifactName[] | undefined): readonly ArtifactName[] {
  if (!requested || requested.length === 0) {
    return resolveAllArtifacts();
  }
  // Deduplicate while preserving order of first occurrence
  const seen = new Set<string>();
  const out: ArtifactName[] = [];
  for (const name of requested) {
    if (ARTIFACT_NAMES.includes(name) && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

async function writeArtifact(outDir: string, fileName: string, content: string): Promise<string> {
  const outPath = resolve(join(outDir, fileName));
  await mkdir(dirname(outPath), { recursive: true });
  const isSensitive = fileName === "default-env.json" || fileName === ".npmrc";
  await writeFile(outPath, content, {
    encoding: "utf8",
    ...(isSensitive ? { mode: 0o600 } : {}),
  });
  if (isSensitive) {
    await chmod(outPath, 0o600);
  }
  return outPath;
}

export async function exportArtifacts(
  options: ExportArtifactsOptions,
): Promise<ExportArtifactsResult> {
  const requested = options.artifacts;
  if (requested?.length === 0) {
    throw new Error("At least one artifact must be selected for export.");
  }
  const artifacts = normalizeRequested(requested);

  const session: OpenCfSession = await openCfSession(options.target);
  const written: string[] = [];
  const skipped: string[] = [];

  try {
    // Automatically enable SSH (and restart app) if any ssh-based artifact is requested.
    // default-env.json uses CF API (no SSH), but regular files (package.json, locks, etc.) require SSH.
    const needsSsh = artifacts.some((name) => name !== "default-env.json");
    if (needsSsh) {
      await ensureSshEnabled(options.target.app, session.context);
    }


    for (const name of artifacts) {
      if (name === "default-env.json") {
        try {
          const json = await fetchDefaultEnvJson({
            appName: options.target.app,
            context: session.context,
          });
          const path = await writeArtifact(options.outDir, name, json);
          written.push(path);
        } catch {
          // Default "all" mode treats every optional remote artifact as best-effort.
          // Only the presence of the file/VCAP in the remote app determines if it can be exported.
          skipped.push(name);
        }
        continue;
      }

      // regular file via ssh
      const remoteRoot = options.remoteRoot;
      const fetchOpts: {
        readonly appName: string;
        readonly fileName: string;
        readonly remoteRoot?: string | undefined;
        readonly context?: CfExecContext;
      } = {
        appName: options.target.app,
        fileName: name,
        context: session.context,
        ...(typeof remoteRoot === "string" ? { remoteRoot } : {}),
      };
      const content = await fetchRemoteTextFile(fetchOpts);

      if (content === null) {
        skipped.push(name);
        continue;
      }

      const path = await writeArtifact(options.outDir, name, content);
      written.push(path);
    }
  } finally {
    await session.dispose();
  }

  return {
    writtenFiles: written,
    skipped,
  };
}

export function getAllArtifactNames(): readonly ArtifactName[] {
  return resolveAllArtifacts();
}
