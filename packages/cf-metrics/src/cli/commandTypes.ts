export interface TargetOpts {
  readonly region?: string;
  readonly org?: string;
  readonly space?: string;
}

export interface CredentialOpts {
  readonly serviceInstance?: string;
  readonly serviceKey: readonly string[];
  readonly fallbackBindingApp: readonly string[];
  readonly allowMintCredential: boolean;
  readonly verbose: boolean;
}

export interface FormatOpts {
  readonly format: string;
}

export interface SaveOpts {
  readonly save: boolean;
}

export interface SampleOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly service?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit: number;
}

export interface MappingOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly index: string;
  readonly field?: string;
}

export interface FieldsOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly service?: string;
  readonly name?: string;
}

export interface NamesOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly service: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit: number;
}

export interface HistoryOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly service: string;
  readonly name: readonly string[];
  readonly since?: string;
  readonly until?: string;
  readonly unit?: string;
  readonly interval: string;
  readonly kind?: string;
}

export interface SnapshotOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly service: string;
}

export interface TopOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly name: string;
  readonly since?: string;
  readonly until?: string;
  readonly unit?: string;
  readonly limit: number;
  readonly kind?: string;
}

export interface WatchOpts extends TargetOpts, CredentialOpts {
  readonly service: string;
  readonly name?: string;
  readonly interval: number;
  readonly lookback: string;
  readonly json: boolean;
}
