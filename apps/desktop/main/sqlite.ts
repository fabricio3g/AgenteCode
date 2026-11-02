/** SQLite built into Electron/Node: no addon ABI rebuild for chat persistence. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
type Statement = { get(...args: any[]): any; all(...args: any[]): any[]; run(...args: any[]): any };

export default class SQLiteDatabase {
  private readonly database: any;
  private readonly statements = new Map<string, Statement>();
  private transactionDepth = 0;
  constructor(file: string) {
    const sqlite = require('node:sqlite');
    const Driver = sqlite.Database ?? sqlite.DatabaseSync;
    this.database = new Driver(file, { timeout: 5000 });
  }
  exec(sql: string): void { this.database.exec(sql); }
  pragma(sql: string): unknown { return this.database.prepare(`PRAGMA ${sql}`).all(); }
  prepare(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      const raw = this.database.prepare(sql);
      const args = (values: any[]) => values.map(value => value === undefined ? null : value);
      statement = {
        get: (...values) => { const row = raw.get(...args(values)); return row && { ...row }; },
        all: (...values) => raw.all(...args(values)).map((row: any) => ({ ...row })),
        run: (...values) => raw.run(...args(values))
      };
      this.statements.set(sql, statement);
      if (this.statements.size > 128) this.statements.delete(this.statements.keys().next().value!);
    }
    return statement;
  }
  transaction<T extends (...args: any[]) => any>(operation: T): T {
    return ((...args: Parameters<T>) => {
      const savepoint = `agente_${this.transactionDepth}`;
      const nested = this.transactionDepth > 0;
      this.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
      this.transactionDepth++;
      try {
        const result = operation(...args);
        this.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
        return result;
      } catch (error) {
        if (nested) { this.exec(`ROLLBACK TO ${savepoint}`); this.exec(`RELEASE ${savepoint}`); }
        else this.exec('ROLLBACK');
        throw error;
      } finally { this.transactionDepth--; }
    }) as T;
  }
  close(): void { this.statements.clear(); this.database.close(); }
}
