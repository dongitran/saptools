import { createCombinedHandler } from 'cds-routing-handlers';
import { ActivateHandlerA } from './ActivateHandler.js';

createCombinedHandler({ handler: [ActivateHandlerA] });
