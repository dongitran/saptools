import cds from '@sap/cds';
import { Action, Handler } from 'cds-routing-handlers';

@Handler()
export class ActivateHandlerA {
  @Action('activate')
  async activate(): Promise<void> {
    await cds.run(SELECT.from(ActivationA));
  }
}
