import cds from '@sap/cds';
import { Action, Function, Handler } from 'cds-routing-handlers';

@Handler()
export class SettingsHandler {
  @Action('applyRules')
  async applyRules(): Promise<void> {
    const settings = cds.services.SettingsService;
    await settings.getRuleInfo('default');
  }

  @Function('getRuleInfo')
  async getRuleInfo(): Promise<void> {
    await cds.run(SELECT.one.from(RuleSettings));
  }
}
