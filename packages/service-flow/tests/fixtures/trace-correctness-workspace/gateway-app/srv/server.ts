import { createCombinedHandler } from 'cds-routing-handlers';
import { GatewayHandler } from './GatewayHandler.js';

createCombinedHandler({ handler: [GatewayHandler] });
