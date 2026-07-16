const REDACTED = "[REDACTED]";

interface CredentialSpan {
  readonly passwordStart: number;
  readonly passwordEnd: number;
}

interface TokenDelimiters {
  readonly colons: readonly number[];
  readonly atSigns: readonly number[];
  readonly slashes: readonly number[];
}

function tokenDelimiters(token: string): TokenDelimiters {
  const colons: number[] = [];
  const atSigns: number[] = [];
  const slashes: number[] = [];
  for (const match of token.matchAll(/[:@/]/gu)) {
    const index = match.index;
    if (match[0] === ":") {
      colons.push(index);
    } else if (match[0] === "@") {
      atSigns.push(index);
    } else {
      slashes.push(index);
    }
  }
  return { colons, atSigns, slashes };
}

function credentialSpansInToken(
  token: string,
  offset: number,
  allowUsernameSlash: boolean,
  replaceAll: boolean,
): readonly CredentialSpan[] {
  const { colons, atSigns, slashes } = tokenDelimiters(token);
  const spans: CredentialSpan[] = [];
  let colonIndex = 0;
  let atIndex = 0;
  let slashIndex = 0;
  let nextStart = 0;
  for (const match of token.matchAll(/https?:\/\//gu)) {
    const start = match.index;
    if (start < nextStart) {
      continue;
    }
    const schemeLength = match[0].length;
    const usernameStart = start + schemeLength;
    while (colonIndex < colons.length && (colons[colonIndex] ?? 0) <= usernameStart) {
      colonIndex += 1;
    }
    const colon = colons[colonIndex];
    if (colon === undefined) {
      break;
    }
    while (slashIndex < slashes.length && (slashes[slashIndex] ?? 0) <= usernameStart) {
      slashIndex += 1;
    }
    if (!allowUsernameSlash && (slashes[slashIndex] ?? token.length) < colon) {
      continue;
    }
    while (atIndex < atSigns.length && (atSigns[atIndex] ?? 0) <= colon) {
      atIndex += 1;
    }
    const atSign = atSigns[atIndex];
    if (atSign !== undefined && atSign > colon + 1) {
      spans.push({ passwordStart: offset + colon + 1, passwordEnd: offset + atSign });
      if (!replaceAll) {
        return spans;
      }
      nextStart = atSign + 1;
    }
  }
  return spans;
}

function findCredentialSpans(
  text: string,
  allowUsernameSlash: boolean,
  replaceAll: boolean,
): readonly CredentialSpan[] {
  const spans: CredentialSpan[] = [];
  for (const match of text.matchAll(/\S+/gu)) {
    const token = match[0];
    const tokenSpans = credentialSpansInToken(
      token,
      match.index,
      allowUsernameSlash,
      replaceAll,
    );
    spans.push(...tokenSpans);
    if (!replaceAll && spans.length > 0) {
      break;
    }
  }
  return spans;
}

function maskUrlCredentials(text: string, replaceAll: boolean, allowUsernameSlash: boolean): string {
  const spans = findCredentialSpans(text, allowUsernameSlash, replaceAll);
  if (spans.length === 0) {
    return text;
  }
  let cursor = 0;
  let output = "";
  for (const span of spans) {
    output += text.slice(cursor, span.passwordStart) + REDACTED;
    cursor = span.passwordEnd;
  }
  return output + text.slice(cursor);
}

export function maskSensitiveText(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((current, secret) => current.split(secret).join(REDACTED), text);
}

export function maskTokenInUrl(value: string): string {
  return maskUrlCredentials(value, false, false);
}

export function maskGitRemotes(text: string): string {
  return maskUrlCredentials(text, true, true);
}

export function maskAll(text: string, secrets: readonly string[]): string {
  return maskGitRemotes(maskSensitiveText(text, secrets));
}
