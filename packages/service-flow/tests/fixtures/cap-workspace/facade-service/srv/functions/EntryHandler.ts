import cds from '@sap/cds';
import { Handler, Func } from 'cds-routing-handlers';
import axios from 'axios';
const DO_WORK = 'doWork';
@Handler()
export class EntryHandler {
  @Func(DO_WORK)
  async doWork(data: unknown): Promise<string> {
    await cds.run(SELECT.from(Template));
    const identity = await cds.connect.to('identity');
    await identity.send({ method: 'POST', path: '/resolveAccess', data });
    const rules = await cds.connect.to('rules');
    await rules.send({ method: 'POST', path: '/checkPayload', data });
    const messaging = await cds.connect.to('messaging');
    await messaging.emit('PayloadChecked', { id: 'sample' });
    await axios({ method: 'POST', url: 'https://example.invalid', headers: { authorization: 'Bearer value', password: 'hidden' }, data });
    return 'ok';
  }
}
