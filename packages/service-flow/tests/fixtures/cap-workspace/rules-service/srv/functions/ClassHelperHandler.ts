import cds from '@sap/cds';

export class ClassHelperHandler {
  async entry(objectCode: string, objectType: string): Promise<void> {
    const { processClient } = await this.createProcessClient(objectCode, objectType);
    await processClient.send({ method: 'POST', path: '/getPaths' });
  }

  createProcessClient = async (objectCode: string, objectType: string) => {
    const processClient = await cds.connect.to(`svc_${objectCode}_process`, {
      credentials: {
        destination: `svc_${objectCode}_process`,
        servicePath: `/${objectType}ProcessService`
      }
    });
    return { processClient };
  };
}
