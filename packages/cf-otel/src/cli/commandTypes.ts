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

export interface FilterOpts {
  readonly service?: string;
  readonly name?: string;
  readonly since?: string;
  readonly until?: string;
  readonly attr: readonly string[];
  readonly errorsOnly: boolean;
  readonly traceIds?: string;
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

export interface FindOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts, FilterOpts {
  /** Required for `find` (enforced by `.requiredOption`), unlike the optional base in {@link FilterOpts}. */
  readonly service: string;
  readonly limit: number;
  readonly sort: string;
}

export interface TopOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly service: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit: number;
  readonly sort: string;
  readonly errorsOnly: boolean;
}

export type CountOpts = TargetOpts & CredentialOpts & FilterOpts & FormatOpts;

export interface SpansOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly fields?: string;
  readonly attr: readonly string[];
  readonly errorsOnly: boolean;
  readonly limit: number;
}

export interface SpanOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly name?: string;
  readonly kind?: string;
  readonly first: boolean;
  readonly all: boolean;
}

export interface FieldsOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly name?: string;
  readonly kind?: string;
}

export interface SelftimeOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly top: number;
  readonly byService: boolean;
  readonly withSamples: boolean;
}

export interface GapsOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly filterNext?: string;
  readonly buckets?: string;
}

export interface DetachedOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly padding: number;
  readonly limit: number;
  readonly sort: string;
}

export interface DiffOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly top: number;
  readonly sort: string;
}
