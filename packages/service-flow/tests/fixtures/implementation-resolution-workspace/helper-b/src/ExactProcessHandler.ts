import cds from '@sap/cds';
import { Action, Handler } from 'cds-routing-handlers';

@Handler()
export class ExactProcessHandler {
  @Action('runExactCheck')
  async runExactCheck(): Promise<void> {
    await cds.run(SELECT.from(UnregisteredExactResults));
  }
}
