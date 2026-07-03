import fs from 'node:fs/promises';
import path from 'node:path';
import type { DiscoveredRepository } from '../types.js';
import { relativePath } from '../utils/path-utils.js';
export async function discoverRepositories(
  rootPath: string,
  ignore: readonly string[]
): Promise<DiscoveredRepository[]> {
  const root = path.resolve(rootPath);
  const ignored = new Set(ignore);
  const found: DiscoveredRepository[] = [];
  async function isRealGitMarker(dir: string): Promise<boolean> {
    const gitPath = path.join(dir, '.git');
    try {
      const st = await fs.stat(gitPath);
      if (st.isDirectory()) {
        const children = await fs.readdir(gitPath);
        return children.includes('HEAD') || children.includes('config');
      }
      if (st.isFile()) {
        const text = await fs.readFile(gitPath, 'utf8');
        return text.trimStart().startsWith('gitdir:');
      }
    } catch {
      /* not a normal git marker */
    }
    try {
      const fixture = await fs.stat(path.join(dir, '.git-fixture'));
      return fixture.isFile() || fixture.isDirectory();
    } catch {
      return false;
    }
  }
  async function walk(dir: string): Promise<void> {
    const rel = relativePath(root, dir);
    if (rel !== '.' && rel.split('/').some((part) => ignored.has(part))) return;
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasMarker = entries.some((e) => e.name === '.git' || e.name === '.git-fixture');
    if (hasMarker && await isRealGitMarker(dir)) {
      found.push({
        name: path.basename(dir),
        absolutePath: dir,
        relativePath: relativePath(root, dir),
        isGitRepo: true
      });
    }
    for (const entry of entries)
      if (entry.isDirectory() && !ignore.includes(entry.name))
        await walk(path.join(dir, entry.name));
  }
  await walk(root);
  return found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
