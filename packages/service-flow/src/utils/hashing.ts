import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
export async function sha256File(filePath: string): Promise<string> { return createHash('sha256').update(await readFile(filePath)).digest('hex'); }
export function sha256Text(text: string): string { return createHash('sha256').update(text).digest('hex'); }
