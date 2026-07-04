import type { EventMeshBinding, EventMeshOAuth } from './eventMeshBindings.js';

type FetchFn = typeof fetch;
export type PublishDestinationKind = 'topic' | 'queue';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fetchMessagingToken(
  oa2: EventMeshOAuth,
  fetchImpl: FetchFn
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const url = new URL(oa2.tokenendpoint);
  if (!url.searchParams.has('grant_type')) {
    url.searchParams.set('grant_type', oa2.granttype ?? 'client_credentials');
  }
  if (!url.searchParams.has('response_type')) {
    url.searchParams.set('response_type', 'token');
  }
  const basic = Buffer.from(`${oa2.clientid}:${oa2.clientsecret}`).toString('base64');
  const res = await fetchImpl(url.toString(), {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token request HTTP ${String(res.status)}: ${text.slice(0, 200)}`);
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || typeof parsed['access_token'] !== 'string') {
    throw new Error('Messaging token response missing access_token');
  }
  const raw = parsed['expires_in'];
  const expiresInSeconds = typeof raw === 'number' && raw > 0 ? raw : 300;
  return { accessToken: parsed['access_token'], expiresInSeconds };
}

export class EventMeshPublishClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly binding: EventMeshBinding,
    private readonly fetchImpl: FetchFn = fetch,
    private readonly now: () => number = Date.now
  ) {}

  async publishEvent(
    destinationKind: PublishDestinationKind,
    destination: string,
    payload: string,
    contentType: string
  ): Promise<number> {
    const token = await this.getToken();
    const collection = destinationKind === 'queue' ? 'queues' : 'topics';
    const url = `${this.binding.messaging.uri}/messagingrest/v1/${collection}/${encodeURIComponent(destination)}/messages`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': contentType, 'x-qos': '0' },
      body: payload,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${String(res.status)}: ${text.slice(0, 500)}`);
    }
    return res.status;
  }

  private async getToken(): Promise<string> {
    if (this.token !== null && this.token.expiresAt - 60000 > this.now()) {
      return this.token.value;
    }
    const { accessToken, expiresInSeconds } = await fetchMessagingToken(
      this.binding.messaging.oa2,
      this.fetchImpl
    );
    this.token = { value: accessToken, expiresAt: this.now() + expiresInSeconds * 1000 };
    return accessToken;
  }
}

const publishClientCache = new WeakMap<EventMeshBinding, EventMeshPublishClient>();

/**
 * Publish a single event to a topic via the SAP Event Mesh REST Messaging API.
 * Clients are cached per binding object so tokens are reused across calls.
 */
export async function publishEventToMesh(
  binding: EventMeshBinding,
  topic: string,
  payload: string,
  contentType: string
): Promise<number> {
  return await publishEventToMeshDestination(binding, 'topic', topic, payload, contentType);
}

export async function publishEventToMeshQueue(
  binding: EventMeshBinding,
  queueName: string,
  payload: string,
  contentType: string
): Promise<number> {
  return await publishEventToMeshDestination(binding, 'queue', queueName, payload, contentType);
}

async function publishEventToMeshDestination(
  binding: EventMeshBinding,
  destinationKind: PublishDestinationKind,
  destination: string,
  payload: string,
  contentType: string
): Promise<number> {
  let client = publishClientCache.get(binding);
  if (client === undefined) {
    client = new EventMeshPublishClient(binding);
    publishClientCache.set(binding, client);
  }
  return await client.publishEvent(destinationKind, destination, payload, contentType);
}
