import { createCombinedHandler } from 'cds-routing-handlers';
import { UserHandler } from './UserHandler.js';

createCombinedHandler({ handler: [UserHandler] });
