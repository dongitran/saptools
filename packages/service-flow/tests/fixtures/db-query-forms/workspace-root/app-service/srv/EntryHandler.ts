import cds from '@sap/cds';
@Handler()
export class EntryHandler {
  @Action('runEntry')
  async runEntry(ID: string, entityName: string): Promise<void> {
    await cds.run(SELECT.from(Books));
    await cds.run(SELECT.one.from(Items).where({ ID }));
    await cds.run(SELECT.one(Books).columns('ID'));
    await cds.run(INSERT.into(this.model['AuditLogs']).entries([{ ID }]));
    await cds.run(UPSERT.into(Books).entries([{ ID }]));
    await cds.run(UPDATE.entity(Items).set({ ID }));
    await cds.run(UPDATE(Books).set({ ID }));
    await cds.run(DELETE.from(this.model['Items']).where({ ID }));
    await cds.run(SELECT.from(this.model[entityName]).where({ ID }));
  }
}
