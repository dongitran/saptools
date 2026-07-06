import cds from '@sap/cds';
import { Action, Handler } from 'cds-routing-handlers';

@Handler()
export class GatewayHandler {
  @Action('runGatewayCheck')
  async runGatewayCheck(
    entityType: string,
    entityShortName: string,
  ): Promise<void> {
    await cds.run(SELECT.from(GatewayChecks));
    const qualityClient = await cds.connect.to('quality-api', {
      credentials: { path: '/QualityService' },
    });
    const processClient = await cds.connect.to(
      `${entityShortName}-process`,
      {
        credentials: {
          destination: `${entityShortName}-destination`,
          path: `/${entityType}ProcessService`,
        },
      },
    );
    await qualityClient.send({ method: 'GET', path: '/runQualityCheck' });
    await processClient.send({ method: 'POST', path: '/runExactCheck' });
  }
}
