export async function sendRemote(
  client: { send(input: unknown): Promise<unknown> },
  method: string,
  path: string,
  data: unknown,
): Promise<unknown> {
  return client.send({ method, path, data });
}
