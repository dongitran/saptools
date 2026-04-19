export interface HanaCredentials {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly password: string;
  readonly schema: string;
  readonly hdiUser: string;
  readonly hdiPassword: string;
  readonly url: string;
  readonly databaseId: string;
  readonly certificate: string;
}

export interface AppHanaEntry {
  readonly app: string;
  readonly org: string;
  readonly space: string;
  readonly region: string;
  readonly hana: HanaCredentials;
}

export interface SqlToolsHanaOptions {
  readonly encrypt: boolean;
  readonly sslValidateCertificate: boolean;
  readonly sslCryptoProvider: string;
}

export interface SqlToolsConnection {
  readonly name: string;
  readonly driver: "SAPHana";
  readonly server: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
  readonly connectionTimeout: number;
  readonly previewLimit: number;
  readonly hanaOptions: SqlToolsHanaOptions;
}

export interface RawHanaCredentials {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly password: string;
  readonly schema: string;
  readonly hdi_user: string;
  readonly hdi_password: string;
  readonly url: string;
  readonly database_id: string;
  readonly certificate: string;
}

export interface RawHanaBinding {
  readonly credentials: RawHanaCredentials;
}

export interface RawVcapServices {
  readonly hana?: readonly RawHanaBinding[];
}

export interface ExportContext {
  readonly app: string;
  readonly org: string;
  readonly space: string;
  readonly region: string;
}
