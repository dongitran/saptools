import cds from '@sap/cds';
import * as util from 'some-third-party-lib';
import { localHelper } from './local-helper';
const legacyUtil = require('legacy-third-party-lib');

@Handler()
export class EntryHandler {
  @Action('runEntry')
  async runEntry(req: Request): Promise<void> {
    await cds.run(SELECT.from(Books).where({ ID: 1 }));
    const service = await cds.connect.to('RemoteService');
    await service.send({ path: '/doWork', method: 'POST' });
    req.reject(400, 'bad request');
    util.format('x');
    legacyUtil.normalize('x');
    JSON.stringify({ ok: true });
    Date.now();
    await localHelper();
    this.internalStep();
  }

  private internalStep(): void {
    return;
  }
}
