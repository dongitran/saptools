import type { Db } from './connection.js';
import { schemaSql } from './schema.js';
export function migrate(db: Db): void {
  db.exec(schemaSql);
  const columns = db
    .prepare('PRAGMA table_info(service_bindings)')
    .all() as Array<{ name?: string }>;
  if (!columns.some((column) => column.name === 'helper_chain_json'))
    db.prepare(
      'ALTER TABLE service_bindings ADD COLUMN helper_chain_json TEXT',
    ).run();
}
