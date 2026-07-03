import { createCombinedHandler } from 'cds-routing-handlers';
import { GetPathsHandler } from './function/GetPathsHandler.js';
export class Server {
  static run(): void {
    createCombinedHandler({ handler: [GetPathsHandler] });
  }
}
