import fs from 'node:fs/promises';
import path from 'node:path';
import type { GeneratedConstantFact } from '../types.js';
import { normalizePath } from '../utils/path-utils.js';
import {
  collectStringConstantLookups,
  type StaticStringConstant,
  type StaticStringRefusal,
} from './string-constant-lookups.js';
import { createSourceFile } from './ts-project.js';

function sourceLine(
  source: ReturnType<typeof createSourceFile>,
  offset: number,
): number {
  return source.getLineAndCharacterOfPosition(offset).line + 1;
}

function generatedFact(
  source: ReturnType<typeof createSourceFile>,
  filePath: string,
  constant: StaticStringConstant,
): GeneratedConstantFact {
  return {
    name: constant.key,
    value: constant.value,
    sourceFile: normalizePath(filePath),
    sourceLine: sourceLine(source, constant.declarationStartOffset),
    containerName: constant.containerName,
    memberName: constant.memberName,
    constantKind: constant.kind,
    exported: constant.exported,
    stable: constant.stable,
    resolutionStatus: 'resolved',
    declarationStartOffset: constant.declarationStartOffset,
    declarationEndOffset: constant.declarationEndOffset,
    valueStartOffset: constant.valueStartOffset,
    valueEndOffset: constant.valueEndOffset,
  };
}

function refusedFact(
  source: ReturnType<typeof createSourceFile>,
  filePath: string,
  refusal: StaticStringRefusal,
): GeneratedConstantFact {
  return {
    name: refusal.key,
    sourceFile: normalizePath(filePath),
    sourceLine: sourceLine(source, refusal.declarationStartOffset),
    containerName: refusal.containerName,
    memberName: refusal.memberName,
    constantKind: refusal.kind,
    exported: refusal.exported,
    stable: refusal.stable,
    resolutionStatus: 'refused',
    unresolvedReason: refusal.reason,
    declarationStartOffset: refusal.declarationStartOffset,
    declarationEndOffset: refusal.declarationEndOffset,
    valueStartOffset: refusal.declarationStartOffset,
    valueEndOffset: refusal.declarationEndOffset,
  };
}

export function generatedConstantFacts(
  source: ReturnType<typeof createSourceFile>,
  filePath: string,
): GeneratedConstantFact[] {
  const lookups = collectStringConstantLookups(source);
  const constants = [
    ...lookups.identifiers.values(),
    ...lookups.enumMembers.values(),
    ...lookups.objectProperties.values(),
  ];
  return [
    ...constants.map((constant) =>
      generatedFact(source, filePath, constant)),
    ...[...lookups.refusedMembers.values()].map((refusal) =>
      refusedFact(source, filePath, refusal)),
  ];
}

export async function parseGeneratedConstants(
  repoPath: string,
  filePath: string,
): Promise<GeneratedConstantFact[]> {
  const text = await fs.readFile(path.join(repoPath, filePath), 'utf8');
  return generatedConstantFacts(createSourceFile(filePath, text), filePath);
}
