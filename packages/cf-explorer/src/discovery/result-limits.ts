import type {
  FindMatch,
  InspectCandidatesResult,
} from "../core/types.js";

import { suggestBreakpoints } from "./parsers.js";

export interface ResultWindow<T> {
  readonly values: readonly T[];
  readonly capped: boolean;
}

type InspectOutput = Pick<
  InspectCandidatesResult,
  "contentMatches" | "files" | "roots" | "suggestedBreakpoints"
>;

export interface InspectResultWindow {
  readonly value: InspectOutput;
  readonly capped: boolean;
}

export function limitResults<T>(values: readonly T[], max: number | undefined): ResultWindow<T> {
  if (max === undefined || values.length <= max) {
    return { values, capped: false };
  }
  return { values: values.slice(0, max), capped: true };
}

export function limitInspectResults(
  parsed: InspectOutput,
  maxFiles: number | undefined,
  maxMatches: number | undefined,
): InspectResultWindow {
  const roots = limitResults(parsed.roots, maxFiles);
  const files = limitOptionalFiles(parsed.files, maxFiles);
  const contentMatches = limitResults(parsed.contentMatches, maxMatches);
  return {
    value: {
      roots: roots.values,
      ...(files === undefined ? {} : { files: files.values }),
      contentMatches: contentMatches.values,
      suggestedBreakpoints: suggestBreakpoints(roots.values, contentMatches.values),
    },
    capped: roots.capped || files?.capped === true || contentMatches.capped,
  };
}

function limitOptionalFiles(
  files: readonly FindMatch[] | undefined,
  maxFiles: number | undefined,
): ResultWindow<FindMatch> | undefined {
  return files === undefined ? undefined : limitResults(files, maxFiles);
}
