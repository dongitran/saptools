export function assertJiraResponseOk(response: Response, message: string): void {
  if (response.ok) {
    return;
  }

  throw new Error(message);
}

export function readJiraHeaders(accessToken: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

export function jsonJiraHeaders(accessToken: string): Record<string, string> {
  return {
    ...readJiraHeaders(accessToken),
    "Content-Type": "application/json",
  };
}
