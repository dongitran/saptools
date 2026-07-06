import cds from '@sap/cds';
import { Action, Handler } from 'cds-routing-handlers';
import { connectPrimaryClients } from './clients.js';
import { sendContextual } from './context-helper.js';
import { sendNested } from './nested-transport.js';

@Handler()
export class GatewayHandler {
  @Action('runCompositeCheck')
  async runCompositeCheck(
    id: string,
    domain: string,
    shortName: string,
  ): Promise<void> {
    await cds.run(SELECT.from(GatewayChecks));
    const { userClient, settingsClient } = await connectPrimaryClients();
    const [domainClient] = [await cds.connect.to('domain-api', {
      credentials: { path: '/DomainCatalogService' },
    })];
    const [processClient] = await Promise.all([
      cds.connect.to(`${shortName}-process`, {
        credentials: {
          destination: `${shortName}-destination`,
          path: `/${domain}ProcessService`,
        },
      }),
    ]);
    await userClient.send({
      method: 'GET',
      path: `/getScope(id='${id}')`,
    });
    await sendNested(settingsClient, 'POST', '/applyRules', { id });
    await sendContextual({ client: userClient });
    await processClient.send({ method: 'POST', path: '/runDeepCheck' });
    await domainClient.send({
      method: 'GET',
      path: `/DomainItems(id='${id}')/children?$top=10`,
    });
  }
}
