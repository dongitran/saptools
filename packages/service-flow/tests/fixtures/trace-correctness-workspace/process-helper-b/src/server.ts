import { createCombinedHandler } from 'cds-routing-handlers';
import { ActivateHandlerB } from './ActivateHandler.js';

createCombinedHandler({ handler: [ActivateHandlerB] });
