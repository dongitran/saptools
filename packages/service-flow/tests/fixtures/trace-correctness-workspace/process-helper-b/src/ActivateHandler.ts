import cds from '@sap/cds';
import { Action, Handler } from 'cds-routing-handlers';

@Handler()
export class ActivateHandlerB {
  @Action('activate')
  async activate(): Promise<void> {
    await cds.run(SELECT.from(ActivationB));
  }
}
