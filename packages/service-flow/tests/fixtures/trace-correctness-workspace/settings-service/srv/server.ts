import { createCombinedHandler } from 'cds-routing-handlers';
import { SettingsHandler } from './SettingsHandler.js';

createCombinedHandler({ handler: [SettingsHandler] });
