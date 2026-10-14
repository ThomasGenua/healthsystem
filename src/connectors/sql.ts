/**
 * Postgres and MySQL polling clients.
 *
 * The drivers are optional dependencies, imported only when a channel
 * actually names one. Northstar's core keeps no required runtime dependency,
 * and an operator who never polls Postgres never installs `pg`.
 *
 * Channel queries always use `?` for the cursor placeholder, matching the
 * existing sqlite dbpoll source. The Postgres adapter rewrites those to $1,
 * $2… so the same channel JSON reads the same way whichever database is
 * behind it.
 */

export interface SqlClient {
  query(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}

export type SqlDriver = "postgres" | "mysql";

/** Rewrites `?` placeholders to Postgres $n, leaving quoted literals alone. */
export function toPositional(sql: string): string {
  let out = "";
  let n = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      out += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      out += c;
      continue;
    }
    out += c === "?" ? `$${++n}` : c;
  }
  return out;
}

/**
 * Loads an optional driver. The specifier is held in a variable so the
 * TypeScript program does not need the package's types to be installed —
 * these are optional dependencies and may legitimately be absent.
 */
async function optionalImport(pkg: string, source: string): Promise<Record<string, unknown>> {
  const specifier: string = pkg;
  try {
    return (await import(specifier)) as Record<string, unknown>;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`the ${source} source needs the optional '${pkg}' package (npm install ${pkg}): ${detail}`);
  }
}

export async function connectSql(driver: SqlDriver, dsn: string): Promise<SqlClient> {
  return driver === "postgres" ? connectPostgres(dsn) : connectMysql(dsn);
}

async function connectPostgres(dsn: string): Promise<SqlClient> {
  const mod = await optionalImport("pg", "pgpoll");
  const pg = (mod.default ?? mod) as { Client: new (cfg: { connectionString: string }) => PgClient };
  const client = new pg.Client({ connectionString: dsn });
  await client.connect();
  return {
    async query(sql, params) {
      const res = await client.query(toPositional(sql), params);
      return res.rows;
    },
    close: () => client.end(),
  };
}

async function connectMysql(dsn: string): Promise<SqlClient> {
  const mod = await optionalImport("mysql2/promise", "mysqlpoll");
  const mysql = (mod.default ?? mod) as { createConnection(dsn: string): Promise<MysqlConnection> };
  const conn = await mysql.createConnection(dsn);
  return {
    async query(sql, params) {
      const [rows] = await conn.execute(sql, params);
      return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
    },
    close: () => conn.end(),
  };
}

interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

interface MysqlConnection {
  execute(sql: string, params: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}
