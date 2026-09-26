import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { D1Like, D1Statement } from '../src/env.ts'

type Param = string | number | bigint | boolean | null

class Statement implements D1Statement {
  constructor(private db: Database, readonly sql: string, readonly params: Param[] = []) {}
  bind(...values: unknown[]): D1Statement {
    return new Statement(this.db, this.sql, values as Param[])
  }
  async run(): Promise<unknown> {
    return this.db.prepare(this.sql).run(...this.params)
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[] }
  }
}

/** D1 on bun:sqlite with the repo migrations applied, for tests and local runs. */
export function sqliteD1(path = ':memory:', migrationsDir = join(import.meta.dir, '../../../migrations/d1')): D1Like & { sqlite: Database } {
  const db = new Database(path, { create: true })
  const applied = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_state'").get()
  if (!applied) {
    for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  }
  return {
    sqlite: db,
    prepare: (sql) => new Statement(db, sql),
    async batch(statements) {
      const tx = db.transaction(() => (statements as Statement[]).map((s) => db.prepare(s.sql).run(...s.params)))
      return tx()
    },
  }
}
