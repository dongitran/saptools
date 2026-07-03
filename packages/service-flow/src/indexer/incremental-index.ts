import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256File } from '../utils/hashing.js';
import { normalizePath } from '../utils/path-utils.js';
import type { Db } from '../db/connection.js';
export async function recordFile(db: Db, repoId: number, repoPath: string, relativeFile: string): Promise<void> { const abs = path.join(repoPath, relativeFile); const stat = await fs.stat(abs); const hash = await sha256File(abs); db.prepare('INSERT INTO files(repo_id,relative_path,extension,sha256,size_bytes,last_indexed_at) VALUES(?,?,?,?,?,?) ON CONFLICT(repo_id,relative_path) DO UPDATE SET sha256=excluded.sha256,size_bytes=excluded.size_bytes,last_indexed_at=excluded.last_indexed_at').run(repoId, normalizePath(relativeFile), path.extname(relativeFile), hash, stat.size, new Date().toISOString()); }
