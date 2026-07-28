import type { SymbolCallFact } from '../types.js';
import {
  parsePackageImportReference,
} from '../parsers/package-fact-contract.js';
import type { Db } from './connection.js';

function directPackageProvenanceValid(call: SymbolCallFact): boolean {
  const binding = parsePackageImportReference(call.evidence.importBinding);
  return Boolean(binding
    && call.evidence.relation === 'package_import'
    && call.evidence.derivedImportBinding === undefined
    && call.importSource === binding.rawModuleSpecifier
    && call.evidence.targetName === binding.requestedPublicName);
}

function derivedPackageProvenanceValid(call: SymbolCallFact): boolean {
  const binding = parsePackageImportReference(
    call.evidence.derivedImportBinding,
  );
  if (!binding || typeof binding.referencedMemberName !== 'string')
    return false;
  const expected = typeof call.evidence.proxyVariableName === 'string'
    ? binding.referencedMemberName : binding.requestedPublicName;
  return call.evidence.relation === 'package_import_derived_member'
    && call.evidence.importBinding === undefined
    && call.importSource === binding.rawModuleSpecifier
    && call.evidence.targetName === expected;
}

export function packageImportProvenanceMissing(
  call: SymbolCallFact,
): boolean {
  if (call.importSource === undefined || call.importSource.startsWith('.'))
    return false;
  return !directPackageProvenanceValid(call)
    && !derivedPackageProvenanceValid(call);
}

export function insertPackageProvenanceDiagnostic(
  db: Db,
  repoId: number,
  calls: readonly SymbolCallFact[],
): number {
  const first = calls[0];
  if (!first) return 0;
  const shown = calls.slice(0, 5).map((call) =>
    `${call.sourceFile}:${call.sourceLine} ${call.calleeExpression.slice(
      0, 80,
    )}`);
  const omitted = Math.max(0, calls.length - shown.length);
  db.prepare(`INSERT INTO diagnostics(
    repo_id,severity,code,message,source_file,source_line
  ) VALUES(?,?,?,?,?,?)`).run(
    repoId,
    'warning',
    'package_import_provenance_missing',
    `${calls.length} package-derived call(s) were retained as unresolved because target provenance could not be proven. Examples: ${
      shown.join('; ')}${omitted > 0 ? `; ${omitted} omitted` : ''}.`,
    first.sourceFile,
    first.sourceLine,
  );
  return 1;
}
