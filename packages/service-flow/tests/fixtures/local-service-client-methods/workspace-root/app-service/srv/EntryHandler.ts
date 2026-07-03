import cds from '@sap/cds';
@Handler()
export class EntryHandler {
  @Action('runEntry')
  async runEntry(): Promise<void> {
    const client = cds.services.BusinessProcessService;
    await client.loadRemoteData('42');
    await client.send({ path: '/notify', method: 'POST' });
  }
}
