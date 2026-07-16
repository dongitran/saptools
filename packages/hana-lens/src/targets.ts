import { PACKAGE_ANNOTATION } from "./types.js";
import type { HanaLensCsn, HanaLensDefinition, HanaLensElement } from "./types.js";

const ASSOCIATION_TYPES = new Set(["cds.Association", "cds.Composition"]);

export interface ResolvedTarget {
  readonly name: string;
  readonly definition: HanaLensDefinition;
}

export type TargetResolution =
  | { readonly status: "resolved"; readonly target: ResolvedTarget }
  | { readonly status: "missing" }
  | { readonly status: "ambiguous" };

export function isAssociationElement(element: HanaLensElement): boolean {
  return ASSOCIATION_TYPES.has(element.type ?? "") && element.target !== undefined;
}

export function isTargetNameMatch(definitionName: string, targetName: string): boolean {
  return definitionName === targetName || definitionName.endsWith(`.${targetName}`);
}

export function findTargetCandidates(csn: HanaLensCsn, targetName: string): readonly ResolvedTarget[] {
  return Object.entries(csn.definitions)
    .filter(([definitionName]) => isTargetNameMatch(definitionName, targetName))
    .map(([name, definition]) => ({ name, definition }));
}

export function findPreferredTargetCandidates(csn: HanaLensCsn, targetName: string): readonly ResolvedTarget[] {
  const exact = csn.definitions[targetName];
  return exact === undefined
    ? findTargetCandidates(csn, targetName)
    : [{ name: targetName, definition: exact }];
}

function packageNameOf(definition: HanaLensDefinition): string | undefined {
  return definition[PACKAGE_ANNOTATION];
}

function resolved(target: ResolvedTarget): TargetResolution {
  return { status: "resolved", target };
}

function singleCandidate(candidates: readonly ResolvedTarget[]): ResolvedTarget | undefined {
  const [candidate, ...rest] = candidates;
  return candidate !== undefined && rest.length === 0 ? candidate : undefined;
}

export function resolveTarget(csn: HanaLensCsn, targetName: string, sourceDefinition: HanaLensDefinition): TargetResolution {
  const candidates = findPreferredTargetCandidates(csn, targetName);
  if (candidates.length === 0) {
    return { status: "missing" };
  }
  const onlyCandidate = singleCandidate(candidates);
  if (onlyCandidate !== undefined) {
    return resolved(onlyCandidate);
  }

  const sourcePackage = packageNameOf(sourceDefinition);
  if (sourcePackage === undefined) {
    return { status: "ambiguous" };
  }

  const samePackage = candidates.filter((candidate) => packageNameOf(candidate.definition) === sourcePackage);
  const onlySamePackage = singleCandidate(samePackage);
  return onlySamePackage === undefined ? { status: "ambiguous" } : resolved(onlySamePackage);
}
