import { Handler, Func } from 'cds-routing-handlers';
@Handler()
export class AccessHandler { @Func('resolveAccess') async resolveAccess(): Promise<boolean> { return true; } }
