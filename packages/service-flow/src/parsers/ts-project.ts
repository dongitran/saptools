import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { normalizePath } from '../utils/path-utils.js';

export interface SourceContextInstrumentation {
  onSourceRead?: (
    repoPath: string,
    filePath: string,
  ) => void | Promise<void>;
  onAstCreated?: (repoPath: string, filePath: string) => void;
}

export interface SourceFileSnapshot {
  repoPath: string;
  filePath: string;
  text: string;
  sizeBytes: number;
  sourceFile: () => ts.SourceFile;
}

export interface RepositorySourceContext {
  get: (filePath: string) => SourceFileSnapshot | undefined;
  entries: () => SourceFileSnapshot[];
}

export async function loadRepositorySourceContext(
  repoPath: string,
  filePaths: string[],
  instrumentation?: SourceContextInstrumentation,
): Promise<RepositorySourceContext> {
  const snapshots = new Map<string, SourceFileSnapshot>();
  for (const inputPath of filePaths) {
    const filePath = normalizePath(inputPath);
    await instrumentation?.onSourceRead?.(repoPath, filePath);
    const text = await fs.readFile(path.join(repoPath, filePath), 'utf8');
    let ast: ts.SourceFile | undefined;
    snapshots.set(filePath, {
      repoPath,
      filePath,
      text,
      sizeBytes: Buffer.byteLength(text),
      sourceFile: () => {
        if (ast) return ast;
        instrumentation?.onAstCreated?.(repoPath, filePath);
        ast = createSourceFile(filePath, text);
        return ast;
      },
    });
  }
  return {
    get: (filePath) => snapshots.get(normalizePath(filePath)),
    entries: () => [...snapshots.values()],
  };
}
export function createSourceFile(
  filePath: string,
  text: string
): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS
  );
}
