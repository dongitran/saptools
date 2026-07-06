import { createCombinedHandler } from 'cds-routing-handlers';
import {
  DynamicDecoratorHandler,
  RunQualityCheckHandler,
} from './RunQualityCheckHandler.js';
import { ScopeHandler } from './ScopeHandler.js';

createCombinedHandler({
  handler: [RunQualityCheckHandler, DynamicDecoratorHandler, ScopeHandler],
});
