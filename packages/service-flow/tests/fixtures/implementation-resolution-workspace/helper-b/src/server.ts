import { createCombinedHandler } from 'cds-routing-handlers';
import { SharedProcessHandler } from './SharedProcessHandler.js';

createCombinedHandler({ handler: [SharedProcessHandler] });
