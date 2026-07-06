import cds from '@sap/cds';
import { Action, Function, Handler } from 'cds-routing-handlers';

@Handler()
export class ProcessHandler {
  @Function('getPathMap')
  async getPathMap(): Promise<void> {
    await cds.run(SELECT.from(ProcessPaths));
  }

  @Action('runDeepCheck')
  async runDeepCheck(): Promise<void> {
    await cds.run(SELECT.from(ProcessChecks));
  }
}
