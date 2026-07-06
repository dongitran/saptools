import { sendRemote } from './transport.js';

export async function sendNested(
  client: { send(input: unknown): Promise<unknown> },
  method: string,
  path: string,
  data: unknown,
): Promise<unknown> {
  return sendRemote(client, method, path, data);
}
