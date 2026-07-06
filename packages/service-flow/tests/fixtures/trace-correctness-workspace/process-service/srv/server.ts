import { createCombinedHandler } from 'cds-routing-handlers';
import { ProcessHandler } from './ProcessHandler.js';

createCombinedHandler({ handler: [ProcessHandler] });
