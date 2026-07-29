import { CfDebuggerError } from "./types.js";

export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

export function validateCfCliOperand(
  value: unknown,
  label: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CfDebuggerError("UNSAFE_INPUT", `${label} must be a non-empty string.`);
  }
  if (value.trim() !== value) {
    throw new CfDebuggerError("UNSAFE_INPUT", `${label} must not contain surrounding whitespace.`);
  }
  if (value.startsWith("-")) {
    throw new CfDebuggerError("UNSAFE_INPUT", `${label} must not start with a hyphen.`);
  }
  if (hasControlCharacter(value)) {
    throw new CfDebuggerError("UNSAFE_INPUT", `${label} must not contain control characters.`);
  }
  return value;
}
