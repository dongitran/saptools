import cds from '@sap/cds';
import { Handler, Func } from 'cds-routing-handlers';
import axios from 'axios';
import { createIdentityClient, createRulesRemote } from './connection-helper.js';
const DO_WORK = 'doWork';
@Handler()
export class EntryHandler {
  @Func(DO_WORK)
  async doWork(data: unknown): Promise<string> {
    await cds.run(SELECT.from(Template));
    const identity = await createIdentityClient();
    await identity.send({ method: 'POST', path: '/resolveAccess', data });
    const rules = await createRulesRemote();
    await rules.send({ method: 'POST', path: '/checkPayload', data });
    const messaging = await cds.connect.to('messaging');
    await messaging.emit('PayloadChecked', { id: 'sample' });
    await axios({
      method: 'POST',
      url: 'https://example.invalid',
      headers: { authorization: 'Bearer value', password: 'hidden' },
      data
    });
    return 'ok';
  }
}
