/**
 * Parsing of SAP Event Mesh ("enterprise-messaging") service bindings out of a
 * Cloud Foundry app's VCAP_SERVICES. Pure and side-effect free so it is unit-testable.
 */

export interface EventMeshOAuth {
  readonly clientid: string;
  readonly clientsecret: string;
  readonly tokenendpoint: string;
  readonly granttype?: string;
}

export interface EventMeshEndpoint {
  readonly uri: string;
  readonly oa2: EventMeshOAuth;
}

export interface EventMeshBinding {
  readonly index: number;
  readonly name: string;
  readonly instanceName: string;
  readonly namespace: string;
  readonly management: EventMeshEndpoint;
  /** REST (httprest) messaging endpoint. */
  readonly messaging: EventMeshEndpoint;
  /** AMQP 1.0 over WebSocket endpoint used to attach the debug receiver. */
  readonly amqp: EventMeshEndpoint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseOAuth(value: unknown): EventMeshOAuth | null {
  if (!isRecord(value)) {
    return null;
  }
  const clientid = readNonEmptyString(value, 'clientid');
  const clientsecret = readNonEmptyString(value, 'clientsecret');
  const tokenendpoint = readNonEmptyString(value, 'tokenendpoint');
  if (clientid === null || clientsecret === null || tokenendpoint === null) {
    return null;
  }
  const granttype = readNonEmptyString(value, 'granttype');
  return granttype === null
    ? { clientid, clientsecret, tokenendpoint }
    : { clientid, clientsecret, tokenendpoint, granttype };
}

function parseEndpoint(entry: unknown): EventMeshEndpoint | null {
  if (!isRecord(entry)) {
    return null;
  }
  const uri = readNonEmptyString(entry, 'uri');
  const oa2 = parseOAuth(entry['oa2']);
  if (uri === null || oa2 === null) {
    return null;
  }
  return { uri: stripTrailingSlash(uri), oa2 };
}

function endpointMatchesProtocol(entry: Record<string, unknown>, protocolToken: string): boolean {
  const protocol = entry['protocol'];
  if (Array.isArray(protocol)) {
    return protocol.some((value) => typeof value === 'string' && value.includes(protocolToken));
  }
  return typeof protocol === 'string' && protocol.includes(protocolToken);
}

function findMessagingByProtocol(
  messaging: readonly unknown[],
  protocolToken: string
): EventMeshEndpoint | null {
  for (const entry of messaging) {
    if (isRecord(entry) && endpointMatchesProtocol(entry, protocolToken)) {
      const endpoint = parseEndpoint(entry);
      if (endpoint !== null) {
        return endpoint;
      }
    }
  }
  return null;
}

function normalizeBinding(service: unknown, index: number): EventMeshBinding | null {
  if (!isRecord(service)) {
    return null;
  }
  const credentials = service['credentials'];
  if (!isRecord(credentials)) {
    return null;
  }
  const namespace = readNonEmptyString(credentials, 'namespace');
  if (namespace === null) {
    return null;
  }

  const managementList = credentials['management'];
  const management =
    Array.isArray(managementList) && managementList.length > 0
      ? parseEndpoint(managementList[0])
      : null;

  const messagingList = credentials['messaging'];
  if (management === null || !Array.isArray(messagingList)) {
    return null;
  }

  const messaging = findMessagingByProtocol(messagingList, 'httprest');
  const amqp = findMessagingByProtocol(messagingList, 'amqp10ws');
  if (messaging === null || amqp === null) {
    return null;
  }

  const name = readNonEmptyString(service, 'name') ?? `enterprise-messaging-${String(index)}`;
  const instanceName = readNonEmptyString(service, 'instance_name') ?? name;

  return { index, name, instanceName, namespace, management, messaging, amqp };
}

/**
 * Extract every usable Event Mesh binding from a parsed default-env.json object or VCAP_SERVICES directly.
 */
export function extractEventMeshBindings(vcapServicesOrEnv: unknown): EventMeshBinding[] {
  if (!isRecord(vcapServicesOrEnv)) {
    return [];
  }
  
  // Try to find VCAP_SERVICES if the input is a full env object
  let vcap = vcapServicesOrEnv;
  if (isRecord(vcapServicesOrEnv['VCAP_SERVICES'])) {
    vcap = vcapServicesOrEnv['VCAP_SERVICES'];
  }
  
  const services = vcap['enterprise-messaging'];
  if (!Array.isArray(services)) {
    return [];
  }

  const bindings: EventMeshBinding[] = [];
  for (const [index, service] of services.entries()) {
    const binding = normalizeBinding(service, index);
    if (binding !== null) {
      bindings.push(binding);
    }
  }
  return bindings;
}
