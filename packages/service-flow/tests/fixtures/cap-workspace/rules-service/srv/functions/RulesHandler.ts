import cds from '@sap/cds';
import { Handler, Func } from 'cds-routing-handlers';
@Handler()
export class RulesHandler {
  @Func('checkPayload')
  async checkPayload(objectCode: string, objectType: string): Promise<boolean> {
    const process = await cds.connect.to(`svc_${objectCode}_process`, {
      kind: 'odata',
      credentials: {
        destination: `svc_${objectCode}_process`,
        path: `/${objectType}ProcessService`,
        requestTimeout: 120000
      }
    });
    await process.send({ method: 'POST', path: '/getPaths' });
    const messaging = await cds.connect.to('messaging');
    messaging.on('PayloadChecked', () => undefined);
    return true;
  }
}
