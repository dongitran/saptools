export interface CfExecContext {
  readonly command?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface CfExecError extends Error {
  readonly stderr?: Buffer | string;
  readonly stdout?: Buffer | string;
  readonly code?: number | string;
}

export type LifecycleAction = "restart" | "restage" | "start" | "stop";

export type RestartStrategy = "default" | "rolling";

export interface LifecyclePlan {
  readonly appName: string;
  readonly action: LifecycleAction;
  readonly strategy: RestartStrategy;
}

export interface ScaleInput {
  readonly appName: string;
  readonly instances?: number;
  readonly memory?: string;
  readonly disk?: string;
  readonly restart: boolean;
  readonly strategy: RestartStrategy;
}

export interface ScalePlan {
  readonly appName: string;
  readonly args: readonly string[];
  readonly restartAfterScale?: LifecyclePlan;
}
