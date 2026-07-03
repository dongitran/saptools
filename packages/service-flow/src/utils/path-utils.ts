import path from 'node:path';
export function normalizePath(value: string): string {
  return value.split(path.sep).join('/');
}
export function relativePath(root: string, value: string): string {
  return normalizePath(path.relative(root, value) || '.');
}
export function ensureLeadingSlash(value: string): string {
  return value.startsWith('/') ? value : `/${value}`;
}
export function stripQuotes(value: string): string {
  return value.replace(/^['"`]|['"`]$/g, '');
}
