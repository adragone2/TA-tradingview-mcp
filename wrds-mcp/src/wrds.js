/**
 * WRDS connection and query guards.
 *
 * WRDS exposes its data as a plain PostgreSQL endpoint, so no vendor SDK is
 * needed — just `pg` and credentials the user controls.
 *
 * Entitlements differ per institution: two subscribers see different schemas.
 * Nothing here hardcodes dataset names for that reason; callers discover what
 * they actually have with listSchemas/listTables/describeTable.
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOST = process.env.WRDS_HOST || 'wrds-pgdata.wharton.upenn.edu';
const PORT = Number(process.env.WRDS_PORT || 9737);
const DATABASE = process.env.WRDS_DB || 'wrds';

// Long enough for a real research query, short enough that a runaway join
// cannot pin a connection to a shared institutional server indefinitely.
const STATEMENT_TIMEOUT_MS = Number(process.env.WRDS_STATEMENT_TIMEOUT_MS || 120000);
// WRDS authentication is routinely slow — well past the few seconds a local
// Postgres takes. Generous by default, and overridable.
const CONNECT_TIMEOUT_MS = Number(process.env.WRDS_CONNECT_TIMEOUT_MS || 60000);
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 50000;

let pool = null;

/**
 * Candidate pgpass locations, in libpq's order of preference.
 * Windows uses %APPDATA%\postgresql\pgpass.conf rather than ~/.pgpass.
 */
function pgpassCandidates() {
  return [
    process.env.PGPASSFILE,
    process.platform === 'win32' && process.env.APPDATA
      ? join(process.env.APPDATA, 'postgresql', 'pgpass.conf')
      : null,
    join(homedir(), '.pgpass'),
  ].filter(Boolean);
}

/** A pgpass field matches when it is a literal match or the `*` wildcard. */
function fieldMatches(pattern, value) {
  return pattern === '*' || pattern === String(value);
}

/**
 * Split a pgpass line on unescaped colons. libpq allows `\:` inside a field,
 * which matters because passwords legitimately contain colons.
 */
function splitPgpassLine(line) {
  const fields = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      current += line[i + 1];
      i++;
    } else if (ch === ':') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Look up credentials from a pgpass file.
 *
 * Reading them here means the password is used by this process only — it never
 * needs to be copied into .env, echoed to a terminal, or shown in a
 * conversation. Returns null when no entry matches.
 */
function fromPgpass({ host, port, database, user } = {}) {
  for (const path of pgpassCandidates()) {
    if (!existsSync(path)) continue;
    let content;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      continue; // unreadable (permissions) — try the next candidate
    }

    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const f = splitPgpassLine(line);
      if (f.length < 5) continue;
      const [h, p, db, u, ...rest] = f;
      const secret = rest.join(':');
      if (!fieldMatches(h, host)) continue;
      if (!fieldMatches(p, port)) continue;
      if (!fieldMatches(db, database)) continue;
      if (user && !fieldMatches(u, user)) continue;
      return { user: u === '*' ? user : u, password: secret, source: path };
    }
  }
  return null;
}

function credentials() {
  // Explicit environment wins, so a user can override a stored entry.
  const envUser = process.env.WRDS_USER;
  const envPassword = process.env.WRDS_PASSWORD;
  if (envUser && envPassword) {
    return { user: envUser, password: envPassword, source: 'environment' };
  }

  const found = fromPgpass({ host: HOST, port: PORT, database: DATABASE, user: envUser });
  if (found?.user && found?.password) return found;

  throw new Error(
    'No WRDS credentials found. Either add an entry to your pgpass file ' +
    `(${pgpassCandidates().join(' or ')}) in the form ` +
    'wrds-pgdata.wharton.upenn.edu:9737:wrds:USERNAME:PASSWORD, or set WRDS_USER and ' +
    'WRDS_PASSWORD in wrds-mcp/.env. Never paste credentials into a chat.',
  );
}

/** Where credentials would come from, without revealing them. */
export function credentialSource() {
  try {
    const c = credentials();
    return { found: true, user: c.user, source: c.source };
  } catch (err) {
    return { found: false, error: err.message };
  }
}

export function getPool() {
  if (pool) return pool;
  const { user, password } = credentials();

  pool = new pg.Pool({
    host: HOST,
    port: PORT,
    database: DATABASE,
    user,
    password,
    // WRDS requires TLS. It presents a certificate that does not validate
    // against the default CA set, so verification is relaxed while the
    // connection stays encrypted.
    ssl: { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });

  pool.on('error', () => { /* a dead idle client must not crash the server */ });
  return pool;
}

export async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    try { await p.end(); } catch { /* already gone */ }
  }
}

/**
 * Reject anything that is not a single read-only statement.
 *
 * WRDS grants are read-only anyway, but this is a shared institutional
 * resource: an accidental write or a stacked statement should fail here with a
 * clear message rather than travel to the server and rely on its permissions.
 */
const FORBIDDEN = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|vacuum|reindex|call|do|refresh)\b/i;

export function assertReadOnly(sql) {
  const text = String(sql || '').trim();
  if (!text) throw new Error('sql is required.');

  // Strip comments before inspecting, so a keyword cannot hide behind `--`.
  const bare = text
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();

  if (!/^(select|with)\b/i.test(bare)) {
    throw new Error('Only SELECT and WITH queries are allowed. This server is read-only.');
  }
  if (FORBIDDEN.test(bare)) {
    throw new Error(
      `Query rejected: it contains a write or DDL keyword. This server is read-only. ` +
      `If a column name collides with a keyword, quote it.`,
    );
  }
  // Reject stacked statements. A trailing semicolon is fine.
  const withoutStrings = bare.replace(/'(?:[^']|'')*'/g, "''");
  const inner = withoutStrings.replace(/;\s*$/, '');
  if (inner.includes(';')) {
    throw new Error('Multiple statements are not allowed — send one query at a time.');
  }
  return bare;
}

/** Append a LIMIT when the caller did not set one, so a stray query cannot stream millions of rows. */
export function applyLimit(sql, limit) {
  const capped = Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT);
  const bare = sql.replace(/;\s*$/, '');
  if (/\blimit\s+\d+/i.test(bare)) return { sql: bare, limit_applied: null };
  return { sql: `${bare}\nLIMIT ${capped}`, limit_applied: capped };
}

export async function query({ sql, params = [], limit } = {}) {
  const checked = assertReadOnly(sql);
  const { sql: finalSql, limit_applied } = applyLimit(checked, limit);

  const started = Date.now();
  const client = await getPool().connect();
  try {
    const res = await client.query(finalSql, params);
    return {
      success: true,
      row_count: res.rowCount,
      columns: (res.fields || []).map((f) => f.name),
      rows: res.rows,
      elapsed_ms: Date.now() - started,
      ...(limit_applied ? { limit_applied, note: `No LIMIT in the query — capped at ${limit_applied} rows.` } : {}),
    };
  } finally {
    client.release();
  }
}

/** Schemas this account can actually read. Entitlements vary per institution. */
export async function listSchemas({ filter } = {}) {
  const res = await query({
    sql: `
      SELECT table_schema AS schema, COUNT(*)::int AS table_count
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        AND ($1 = '' OR table_schema ILIKE '%' || $1 || '%')
      GROUP BY table_schema
      ORDER BY table_schema
    `,
    params: [filter || ''],
    limit: 5000,
  });
  return { success: true, schema_count: res.row_count, schemas: res.rows };
}

export async function listTables({ schema, filter } = {}) {
  if (!schema) throw new Error('schema is required. Use wrds_list_schemas to see what you can read.');
  const res = await query({
    sql: `
      SELECT table_name AS table, table_type AS type
      FROM information_schema.tables
      WHERE table_schema = $1
        AND ($2 = '' OR table_name ILIKE '%' || $2 || '%')
      ORDER BY table_name
    `,
    params: [schema, filter || ''],
    limit: 5000,
  });
  return { success: true, schema, table_count: res.row_count, tables: res.rows };
}

export async function describeTable({ schema, table } = {}) {
  if (!schema || !table) throw new Error('schema and table are both required.');
  const res = await query({
    sql: `
      SELECT column_name AS column, data_type AS type, is_nullable AS nullable
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `,
    params: [schema, table],
    limit: 2000,
  });
  if (!res.row_count) {
    throw new Error(`No table ${schema}.${table} visible to this account. It may not be part of your institution's entitlement.`);
  }
  return { success: true, schema, table, column_count: res.row_count, columns: res.rows };
}

export async function healthCheck() {
  const started = Date.now();
  try {
    const res = await query({ sql: 'SELECT current_user AS user, version() AS version', limit: 1 });
    const schemas = await listSchemas();
    // Surface the well-known vendor schemas so the caller can see at a glance
    // what this subscription includes.
    const names = schemas.schemas.map((s) => s.schema);
    const notable = ['crsp', 'comp', 'ibes', 'optionm', 'taq', 'ciq', 'ravenpack', 'wrdsapps']
      .filter((n) => names.some((s) => s === n || s.startsWith(`${n}_`)));

    return {
      success: true,
      connected: true,
      host: HOST,
      port: PORT,
      database: DATABASE,
      wrds_user: res.rows[0]?.user,
      server_version: String(res.rows[0]?.version || '').split(' ').slice(0, 2).join(' '),
      schemas_visible: names.length,
      notable_datasets: notable,
      elapsed_ms: Date.now() - started,
    };
  } catch (err) {
    return {
      success: false,
      connected: false,
      host: HOST,
      port: PORT,
      error: err.message,
      hint:
        'Check WRDS_USER / WRDS_PASSWORD in wrds-mcp/.env, that your WRDS subscription is active, and that ' +
        'your network allows outbound TCP to port 9737. First-time programmatic access sometimes requires ' +
        'signing in to the WRDS website once to accept current terms.',
    };
  }
}

export const CONNECTION_INFO = { host: HOST, port: PORT, database: DATABASE };
