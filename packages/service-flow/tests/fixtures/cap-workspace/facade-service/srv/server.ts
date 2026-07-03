import cds from '@sap/cds';
import { createCombinedHandler } from 'cds-routing-handlers';
import { handlers } from './functions/function.module.js';
cds.on('serving', srv => {
  const hdl = createCombinedHandler({ handler: [...handlers] });
  srv.prepend(hdl);
});
