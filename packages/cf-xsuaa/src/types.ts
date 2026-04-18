export interface AppRef {
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
}

export interface XsuaaCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly url: string;
  readonly xsappname?: string;
}

export interface CachedToken {
  readonly accessToken: string;
  readonly expiresAt: string;
}

export interface XsuaaEntry extends AppRef {
  readonly credentials: XsuaaCredentials;
  readonly token?: CachedToken;
  readonly fetchedAt: string;
}

export interface XsuaaStore {
  readonly version: 1;
  readonly entries: readonly XsuaaEntry[];
}

export interface RawVcapUaaCredentials {
  readonly clientid: string;
  readonly clientsecret: string;
  readonly url: string;
  readonly xsappname?: string;
}

export interface RawVcapBinding {
  readonly name?: string;
  readonly label?: string;
  readonly credentials: RawVcapUaaCredentials;
}

export interface RawVcapServices {
  readonly xsuaa?: readonly RawVcapBinding[];
}

export type FetchSecretFn = (ref: AppRef) => Promise<XsuaaCredentials>;

export type FetchTokenFn = (creds: XsuaaCredentials) => Promise<string>;
