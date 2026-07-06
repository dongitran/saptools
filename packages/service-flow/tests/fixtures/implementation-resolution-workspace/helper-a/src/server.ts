import { createCombinedHandler } from 'cds-routing-handlers';
import { ExactProcessHandler } from './ExactProcessHandler.js';
import { SharedProcessHandler } from './SharedProcessHandler.js';

createCombinedHandler({
  handler: [ExactProcessHandler, SharedProcessHandler],
});
