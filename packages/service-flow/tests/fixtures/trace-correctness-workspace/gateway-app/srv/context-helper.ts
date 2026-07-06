export async function sendContextual(
  { client }: { client: { send(input: unknown): Promise<unknown> } },
): Promise<unknown> {
  return client.send({ method: 'GET', path: '/getScope' });
}
