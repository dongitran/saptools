import cds from '@sap/cds';
import { Function, Handler } from 'cds-routing-handlers';

@Handler()
export class UserHandler {
  @Function('getScope')
  async getScope(): Promise<void> {
    await cds.run(SELECT.one.from(UserProfiles));
  }
}
