import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db, DbStatement, DbValue } from '../../src/api/env.ts'

const MIGRATIONS = join(import.meta.dir, '../../../../migrations/d1')

class Statement implements DbStatement {
  constructor(private readonly db: Database, private readonly sql: string, private readonly values: DbValue[] = []) {}
  bind(...values: DbValue[]): DbStatement {
    return new Statement(this.db, this.sql, values)
  }
  async first<T>(): Promise<T | null> {
    return (this.db.query(this.sql).get(...this.values) as T | null) ?? null
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.query(this.sql).all(...this.values) as T[] }
  }
  async run(): Promise<unknown> {
    return this.db.query(this.sql).run(...this.values)
  }
}

/** In-memory D1 stand-in with every migrations/d1/*.sql applied in order. */
export function memoryD1(): Db & { raw: Database } {
  const db = new Database(':memory:', { strict: true })
  db.exec('PRAGMA foreign_keys = ON')
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'))
  return { raw: db, prepare: (sql) => new Statement(db, sql) }
}
