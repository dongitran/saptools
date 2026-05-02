import { describe, expect, it, vi } from "vitest";

import {
  appSearchPromptTestHelpers,
  promptForAppSelection,
} from "../../src/app-search-prompt.js";

const appChoices = [
  { value: "alpha-main", name: "alpha-main" },
  { value: "alpha-system", name: "alpha-system" },
  { value: "alpha-admin", name: "alpha-admin" },
  { value: "reports-alpha", name: "reports-alpha" },
] as const;

describe("app-search-prompt", () => {
  it("returns all apps when the search term is empty", () => {
    expect(appSearchPromptTestHelpers.buildAppSearchChoices(appChoices, undefined)).toEqual(appChoices);
    expect(appSearchPromptTestHelpers.buildAppSearchChoices(appChoices, "   ")).toEqual(appChoices);
  });

  it("filters apps case-insensitively", () => {
    const result = appSearchPromptTestHelpers.buildAppSearchChoices(appChoices, "AdMiN");
    expect(result).toEqual([{ value: "alpha-admin", name: "alpha-admin" }]);
  });

  it("ranks exact and prefix matches ahead of broad substring matches", () => {
    const result = appSearchPromptTestHelpers.buildAppSearchChoices(appChoices, "alpha");
    expect(result).toEqual([
      { value: "alpha-main", name: "alpha-main" },
      { value: "alpha-system", name: "alpha-system" },
      { value: "alpha-admin", name: "alpha-admin" },
      { value: "reports-alpha", name: "reports-alpha" },
    ]);
  });

  it("ranks exact matches before prefix matches", () => {
    const choices = [
      { value: "alpha", name: "alpha" },
      { value: "alpha-main", name: "alpha-main" },
      { value: "beta-alpha", name: "beta-alpha" },
    ] as const;

    expect(appSearchPromptTestHelpers.buildAppSearchChoices(choices, "alpha")).toEqual([
      { value: "alpha", name: "alpha" },
      { value: "alpha-main", name: "alpha-main" },
      { value: "beta-alpha", name: "beta-alpha" },
    ]);
  });

  it("returns a disabled placeholder when no apps match", () => {
    expect(appSearchPromptTestHelpers.buildAppSearchChoices(appChoices, "does-not-exist")).toEqual([
      {
        value: "__saptools_no_matching_app__",
        name: 'No apps match "does-not-exist"',
        disabled: "Type a different search term",
      },
    ]);
  });

  it("delegates to the search prompt and returns the chosen app", async () => {
    const searchPrompt = vi.fn(async (config: {
      readonly message: string;
      readonly source: (term: string | undefined, opt: { signal: AbortSignal }) => Promise<readonly unknown[]>;
      readonly pageSize?: number;
      readonly validate?: (value: string) => boolean | string | Promise<boolean | string>;
    }) => {
      expect(config.message).toBe("Select app");
      expect(config.pageSize).toBe(12);
      const result = await config.source("alpha-ad", { signal: new AbortController().signal });
      expect(result).toEqual([{ value: "alpha-admin", name: "alpha-admin" }]);
      expect(config.validate?.("__saptools_no_matching_app__")).toBe("Select a real app.");
      expect(config.validate?.("alpha-admin")).toBe(true);
      return "alpha-admin";
    });

    const result = await promptForAppSelection(appChoices, { searchPrompt });

    expect(result).toBe("alpha-admin");
    expect(searchPrompt).toHaveBeenCalledOnce();
  });
});
