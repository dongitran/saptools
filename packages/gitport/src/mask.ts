const REDACTED = "[REDACTED]";

export function maskSensitiveText(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((current, secret) => current.split(secret).join(REDACTED), text);
}

export function maskTokenInUrl(value: string): string {
  return value.replace(/(https?:\/\/[^:\s/]+:)([^@\s]+)(@)/, `$1${REDACTED}$3`);
}

export function maskGitRemotes(text: string): string {
  return text.replace(/(https?:\/\/[^:\s]+:)([^@\s]+)(@)/g, `$1${REDACTED}$3`);
}

export function maskAll(text: string, secrets: readonly string[]): string {
  return maskGitRemotes(maskSensitiveText(text, secrets));
}
