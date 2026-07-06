import cds from '@sap/cds';

export async function connectPrimaryClients(): Promise<Record<string, unknown>> {
  const userClient = await cds.connect.to('user-api');
  const settingsClient = await cds.connect.to('settings-api');
  return { userClient, settingsClient };
}
