import { describe, expect, it, vi } from "vitest";

import {
  environmentPromptTestHelpers,
  promptForEnvironments,
} from "../../src/environment-prompt.js";

describe("promptForEnvironments", () => {
  it("returns an inline warning when nothing is selected", () => {
    expect(environmentPromptTestHelpers.validateEnvironmentSelection([])).toMatch(
      /Select at least one environment/,
    );
  });

  it("returns selected environments immediately when no custom name is requested", async () => {
    const checkboxPrompt = vi.fn(async () => ["local", "dev"]);

    const result = await promptForEnvironments(
      {
        common: ["local", "dev", "staging", "prod"],
        existing: [],
      },
      {
        checkboxPrompt,
      },
    );

    expect(result).toEqual(["local", "dev"]);
    expect(checkboxPrompt).toHaveBeenCalledOnce();
  });

  it("adds a custom environment, then returns to the same menu with it selected", async () => {
    const checkboxPrompt = vi
      .fn()
      .mockImplementationOnce(async () => ["local", "dev", "__saptools_add_custom_environment__"])
      .mockImplementationOnce(async () => ["local", "dev", "uit"]);
    const inputPrompt = vi.fn(async () => "uit");

    const result = await promptForEnvironments(
      {
        common: ["local", "dev", "staging", "prod"],
        existing: [],
      },
      {
        checkboxPrompt,
        inputPrompt,
      },
    );

    expect(result).toEqual(["local", "dev", "uit"]);
    expect(inputPrompt).toHaveBeenCalledOnce();

    const secondCall = checkboxPrompt.mock.calls[1]?.[0];
    const customChoice = secondCall?.choices.find(
      (choice: unknown) => typeof choice === "object" && choice !== null && "value" in choice && choice.value === "uit",
    );
    expect(customChoice).toMatchObject({
      value: "uit",
      name: "uit",
      checked: true,
    });
  });

  it("keeps the add-custom action available after a custom name is added", async () => {
    const checkboxPrompt = vi
      .fn()
      .mockImplementationOnce(async () => ["__saptools_add_custom_environment__"])
      .mockImplementationOnce(async () => ["sandbox"]);
    const inputPrompt = vi.fn(async () => "sandbox");

    await promptForEnvironments(
      {
        common: ["local", "dev", "staging", "prod"],
        existing: [],
      },
      {
        checkboxPrompt,
        inputPrompt,
      },
    );

    const secondCall = checkboxPrompt.mock.calls[1]?.[0];
    const addCustomChoice = secondCall?.choices.find(
      (choice: unknown) =>
        typeof choice === "object" &&
        choice !== null &&
        "value" in choice &&
        choice.value === "__saptools_add_custom_environment__",
    );
    expect(addCustomChoice).toMatchObject({
      value: "__saptools_add_custom_environment__",
      name: "Add custom environment",
    });
  });
});
