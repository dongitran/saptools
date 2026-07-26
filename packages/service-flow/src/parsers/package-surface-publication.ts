import type {
  ExecutableSymbolFact,
  PackageFacts,
} from '../types.js';
import { normalizePath } from '../utils/path-utils.js';
import type { PackageEntrypointManifest } from './package-json-parser.js';
import {
  analyzePackagePublicSurface,
  type PackagePublicSurfaceAnalysis,
  type SymbolPublicSurfaceEvidence,
} from './package-public-surface.js';
import type { RepositorySourceContext } from './ts-project.js';

function symbolIdentity(
  symbol: Pick<
    ExecutableSymbolFact,
    'sourceFile' | 'kind' | 'qualifiedName' | 'startOffset' | 'endOffset'
  >,
): string {
  return [
    symbol.sourceFile,
    symbol.kind,
    symbol.qualifiedName,
    symbol.startOffset,
    symbol.endOffset,
  ].join('\0');
}

function exposureBySymbol(
  analysis: PackagePublicSurfaceAnalysis,
): Map<string, SymbolPublicSurfaceEvidence> {
  return new Map(analysis.symbols.map((item) => [
    symbolIdentity({
      sourceFile: item.target.sourceFile,
      kind: item.target.kind,
      qualifiedName: item.target.qualifiedName,
      startOffset: item.target.startOffset,
      endOffset: item.target.endOffset,
    }),
    item,
  ]));
}

export function analyzeRepositoryPackageSurface(
  facts: PackageFacts,
  manifest: PackageEntrypointManifest,
  sources: RepositorySourceContext,
): PackagePublicSurfaceAnalysis {
  const modules = sources.entries()
    .filter((snapshot) => /\.[jt]s$/.test(snapshot.filePath))
    .map((snapshot) => ({
      sourceFile: normalizePath(snapshot.filePath),
      source: snapshot.sourceFile(),
    }));
  return analyzePackagePublicSurface(facts.packageName, manifest, modules);
}

export function mergePackageSymbolEvidence(
  symbols: readonly ExecutableSymbolFact[],
  analysis: PackagePublicSurfaceAnalysis,
): ExecutableSymbolFact[] {
  const exposures = exposureBySymbol(analysis);
  return symbols.map((symbol) => {
    const exposure = exposures.get(symbolIdentity(symbol));
    if (!exposure) return symbol;
    return {
      ...symbol,
      importExportEvidence: {
        ...(symbol.importExportEvidence ?? {}),
        packagePublicSurface: {
          schema: analysis.surface.schema,
          recordCap: analysis.surface.recordCap,
          bodyEligibility: exposure.target.bodyEligibility,
          exposures: exposure.exposures,
          exposureTotal: exposure.exposureTotal,
          shownExposureCount: exposure.shownExposureCount,
          omittedExposureCount: exposure.omittedExposureCount,
        },
      },
    };
  });
}
