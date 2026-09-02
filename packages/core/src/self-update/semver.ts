export interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

const SEMVER_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemver(text: string): SemanticVersion | undefined {
  const match = SEMVER_PATTERN.exec(text.trim());
  if (match === null) {
    return;
  }
  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    return;
  }
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? [] : prerelease.split("."),
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    return Math.sign(Number(left) - Number(right));
  }
  // Numeric identifiers always sort before alphanumeric ones (semver 2.0.0 §11).
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  // A release outranks any prerelease of the same version.
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }
  for (const [index, identifier] of left.entries()) {
    const other = right[index];
    if (other === undefined) {
      return 1;
    }
    const result = compareIdentifiers(identifier, other);
    if (result !== 0) {
      return result;
    }
  }
  return left.length < right.length ? -1 : 0;
}

export function compareSemver(left: SemanticVersion, right: SemanticVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) {
      return left[key] < right[key] ? -1 : 1;
    }
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * True when `candidate` is a release strictly newer than `current`. A
 * prerelease is never a target: someone who installed 1.2.0 must not be moved
 * onto 1.3.0-beta.1 by a background updater.
 */
export function isNewerRelease(candidate: string, current: string): boolean {
  const next = parseSemver(candidate);
  const installed = parseSemver(current);
  if (next === undefined || installed === undefined) {
    return false;
  }
  if (next.prerelease.length > 0) {
    return false;
  }
  return compareSemver(next, installed) > 0;
}
