import cds from '@sap/cds';
import { Action, Handler } from 'cds-routing-handlers';

@Handler()
export class SharedProcessHandler {
  @Action('runSharedCheck')
  async runSharedCheck(): Promise<void> {
    await cds.run(SELECT.from(SharedResultsB));
  }
}
