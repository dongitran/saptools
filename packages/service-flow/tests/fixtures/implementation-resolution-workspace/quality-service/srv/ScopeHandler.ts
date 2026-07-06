import { Func, Handler } from 'cds-routing-handlers';

@Handler()
export class ScopeHandler {
  @Func('getUserScope')
  async getUserScope(): Promise<string> {
    return 'scope';
  }
}
