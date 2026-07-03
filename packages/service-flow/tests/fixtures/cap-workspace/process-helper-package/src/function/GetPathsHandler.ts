import { Handler, Func } from 'cds-routing-handlers';
@Handler()
export class GetPathsHandler { @Func('getPaths') async getPaths(): Promise<string> { return 'GraphMetadata traversal'; } }
