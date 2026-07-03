import type { Db } from './connection.js';
import { schemaSql } from './schema.js';
export function migrate(db: Db): void { db.exec(schemaSql); }
