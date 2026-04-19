import { describe, expect, it, vi } from "vitest";

import {
  appSearchPromptTestHelpers,
  promptForAppSelection,
} from "../../src/app-search-prompt.js";

const appChoices = [
  { value: "config-main", name: "config-main" },
  { value: "config-system", name: "config-system" },
  { value: "config-admin", name: "config-admin" },
  { value: "main-config-reports", name: "main-config-reports" },
] as const;

describe("app-search-prompt", () => {
  it("returns all apps when the search term is empty", () => {
    expect(appSearchPromptTestHelpers.buildAppSearchChoices(appChoices, undefined)).toEqual(appChoices);
    expect(appSearchPromptTestHelpers.buildAppSearchChoices(appChoices, "   ")).toEqual(appChoices);
  });

  it("filters apps case-insensitively", () => {
    const result = appSearchPromptTestHelpers.buildAppSearchChoices(appChoices, "AdMiN");
    expect(result).toEqual([{ value: "config-admin", name: "config-admin" }]);
  });

  it("ranks exact and prefix matches ahead of broad substring matches", () => {
    const result = appSearchPromptTestHelpers.buildAppSearchChoices(appChoices, "config");
    expect(result).toEqual([
      { value: "config-main", name: "config-main" },
      { value: "config-system", name: "config-system" },
      { value: "config-admin", name: "config-admin" },
      { value: "main-config-reports", name: "main-config-reports" },
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
      const result = await config.source("config-ad", { signal: new AbortController().signal });
      expect(result).toEqual([{ value: "config-admin", name: "config-admin" }]);
      return "config-admin";
    });

    const result = await promptForAppSelection(appChoices, { searchPrompt });

    expect(result).toBe("config-admin");
    expect(searchPrompt).toHaveBeenCalledOnce();
  });
});
