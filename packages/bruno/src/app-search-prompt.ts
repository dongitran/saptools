import { search } from "@inquirer/prompts";

export interface AppChoice {
  readonly value: string;
  readonly name: string;
}

interface SearchResultChoice extends AppChoice {
  readonly disabled?: boolean | string;
}

interface AppSearchPromptConfig {
  readonly message: string;
  readonly pageSize: number;
  readonly source: (
    term: string | undefined,
    opt: { signal: AbortSignal },
  ) => Promise<readonly SearchResultChoice[]>;
  readonly validate: (value: string) => boolean | string | Promise<boolean | string>;
}

interface AppSearchPromptDeps {
  readonly searchPrompt?: (config: AppSearchPromptConfig) => Promise<string>;
}

const DEFAULT_PAGE_SIZE = 12;
const NO_MATCHING_APP = "__saptools_no_matching_app__";

function normalizeTerm(term: string | undefined): string {
  return term?.trim().toLowerCase() ?? "";
}

function scoreChoice(choice: AppChoice, normalizedTerm: string): number {
  const name = choice.name.toLowerCase();
  const value = choice.value.toLowerCase();

  if (name === normalizedTerm || value === normalizedTerm) {
    return 0;
  }
  if (name.startsWith(normalizedTerm) || value.startsWith(normalizedTerm)) {
    return 1;
  }
  if (name.includes(normalizedTerm) || value.includes(normalizedTerm)) {
    return 2;
  }
  return Number.POSITIVE_INFINITY;
}

function noMatchChoice(term: string | undefined): SearchResultChoice {
  const label = term?.trim() ?? "";
  return {
    value: NO_MATCHING_APP,
    name: `No apps match "${label}"`,
    disabled: "Type a different search term",
  };
}

function buildAppSearchChoices(
  choices: readonly AppChoice[],
  term: string | undefined,
): readonly SearchResultChoice[] {
  const normalizedTerm = normalizeTerm(term);
  if (normalizedTerm.length === 0) {
    return [...choices];
  }

  const rankedMatches = choices
    .map((choice, index) => ({ choice, index, score: scoreChoice(choice, normalizedTerm) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((item) => item.choice);

  if (rankedMatches.length > 0) {
    return rankedMatches;
  }

  return [noMatchChoice(term)];
}

export async function promptForAppSelection(
  choices: readonly AppChoice[],
  deps: AppSearchPromptDeps = {},
): Promise<string> {
  const searchPrompt = deps.searchPrompt ?? search;
  return await searchPrompt({
    message: "Select app",
    pageSize: DEFAULT_PAGE_SIZE,
    source: (term) => Promise.resolve(buildAppSearchChoices(choices, term)),
    validate: (value) => (value === NO_MATCHING_APP ? "Select a real app." : true),
  });
}

export const appSearchPromptTestHelpers = {
  buildAppSearchChoices,
};
