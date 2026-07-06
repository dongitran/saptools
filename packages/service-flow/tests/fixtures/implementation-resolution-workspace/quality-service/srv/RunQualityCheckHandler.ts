import cds from '@sap/cds';
import { Func, Handler } from 'cds-routing-handlers';

enum OperationName {
  name = 'runQualityCheck',
}

function dynamicOperationName(): string {
  return 'runDynamicCheck';
}

@Handler()
export class RunQualityCheckHandler {
  @Func(OperationName.name)
  async runQualityCheck(): Promise<string> {
    await cds.run(SELECT.from(QualityRecords));
    const processClient = await cds.connect.to('process-api', {
      credentials: { path: '/EntityAProcessService' },
    });
    await processClient.send({ method: 'POST', path: '/runExactCheck' });
    return 'ok';
  }
}

@Handler()
export class DynamicDecoratorHandler {
  @Func(dynamicOperationName())
  async runDynamicCheck(): Promise<string> {
    return 'dynamic';
  }
}
