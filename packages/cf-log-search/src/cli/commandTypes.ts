export interface TargetOpts {
  readonly region?: string;
  readonly org?: string;
  readonly space?: string;
}

/** No `allowMintCredential` field, deliberately — see the Global Constraints note on why `--allow-mint-credential` is not exposed in v1. */
export interface CredentialOpts {
  readonly serviceInstance?: string;
  readonly serviceKey: readonly string[];
  readonly fallbackBindingApp: readonly string[];
  readonly refreshCredential: boolean;
  readonly verbose: boolean;
}

export interface FormatOpts {
  readonly format: string;
}

export interface SaveOpts {
  readonly save: boolean;
}

export interface SearchOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly app?: string;
  readonly logSpace?: string;
  readonly level?: string;
  readonly sourceType?: string;
  readonly query?: string;
  readonly vcapRequestId?: string;
  readonly correlationId?: string;
  readonly status?: number;
  readonly since?: string;
  readonly until?: string;
  readonly limit: number;
}

export interface CountOpts extends TargetOpts, CredentialOpts {
  readonly app?: string;
  readonly logSpace?: string;
  readonly level?: string;
  readonly sourceType?: string;
  readonly query?: string;
  readonly vcapRequestId?: string;
  readonly correlationId?: string;
  readonly status?: number;
  readonly since?: string;
  readonly until?: string;
}

export interface FieldsOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly raw: boolean;
  readonly index?: string;
}

export interface AppsOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly since?: string;
  readonly until?: string;
  readonly limit: number;
}

export interface ErrorsOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly app?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit: number;
}

export interface LatencyOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly app?: string;
  readonly by: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit: number;
}

export interface TopRoutesOpts extends TargetOpts, CredentialOpts, FormatOpts, SaveOpts {
  readonly app?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit: number;
}
