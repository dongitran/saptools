import { Separator, checkbox, input } from "@inquirer/prompts";

import type { EnvironmentSelection } from "../commands/setup-app.js";
import { assertValidEnvName } from "../commands/setup-app.js";

const ADD_CUSTOM_ENVIRONMENT = "__saptools_add_custom_environment__";

interface EnvironmentChoice {
  readonly value: string;
  readonly name: string;
  readonly checked?: boolean;
  readonly description?: string;
}

interface CheckboxChoiceState {
  readonly value: string;
}

interface EnvironmentPromptDeps {
  readonly checkboxPrompt?: (config: {
    message: string;
    choices: readonly (Separator | EnvironmentChoice)[];
    validate: (choices: readonly CheckboxChoiceState[]) => boolean | string;
  }) => Promise<string[]>;
  readonly inputPrompt?: (config: {
    message: string;
    default: string;
    validate: (value: string) => boolean | string;
  }) => Promise<string>;
}

function uniqueNames(names: readonly string[]): string[] {
  const merged: string[] = [];
  for (const name of names) {
    if (!merged.includes(name)) {
      merged.push(name);
    }
  }
  return merged;
}

function validateEnvironmentSelection(choices: readonly CheckboxChoiceState[]): boolean | string {
  const selected = choices.map((choice) => choice.value);
  const hasEnvironment = selected.some((value) => value !== ADD_CUSTOM_ENVIRONMENT);
  if (hasEnvironment || selected.includes(ADD_CUSTOM_ENVIRONMENT)) {
    return true;
  }
  return 'Select at least one environment, or choose "Add custom environment".';
}

function buildEnvironmentChoices(
  names: readonly string[],
  selected: ReadonlySet<string>,
): readonly (Separator | EnvironmentChoice)[] {
  return [
    ...names.map((name) => ({
      value: name,
      name,
      checked: selected.has(name),
    })),
    new Separator(),
    {
      value: ADD_CUSTOM_ENVIRONMENT,
      name: "Add custom environment",
      description: "Create another environment name and return to this menu",
    },
  ];
}

function validateCustomEnvironmentName(value: string): boolean | string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return true;
  }

  try {
    assertValidEnvName(trimmed);
    return true;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function promptForEnvironments(
  opts: EnvironmentSelection,
  deps: EnvironmentPromptDeps = {},
): Promise<readonly string[]> {
  const checkboxPrompt = deps.checkboxPrompt ?? checkbox;
  const inputPrompt = deps.inputPrompt ?? input;
  const selected = new Set<string>(opts.existing);
  const customNames: string[] = [];

  for (;;) {
    const names = uniqueNames([...opts.common, ...opts.existing, ...customNames]);
    const answers = await checkboxPrompt({
      message: "Environments to create (space to toggle, enter to continue)",
      choices: buildEnvironmentChoices(names, selected),
      validate: validateEnvironmentSelection,
    });

    selected.clear();
    for (const name of answers) {
      if (name !== ADD_CUSTOM_ENVIRONMENT) {
        selected.add(name);
      }
    }

    if (!answers.includes(ADD_CUSTOM_ENVIRONMENT)) {
      return [...selected];
    }

    const custom = (await inputPrompt({
      message: "Custom environment name (leave empty to go back)",
      default: "",
      validate: validateCustomEnvironmentName,
    })).trim();

    if (custom.length === 0) {
      continue;
    }

    if (!customNames.includes(custom) && !names.includes(custom)) {
      customNames.push(custom);
    }
    selected.add(custom);
  }
}

export const environmentPromptTestHelpers = {
  buildEnvironmentChoices,
  validateEnvironmentSelection,
  validateCustomEnvironmentName,
};
