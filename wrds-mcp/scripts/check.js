#!/usr/bin/env node
/**
 * Standalone WRDS connectivity check.
 *
 * Deliberately runnable without Claude: if this fails, the MCP server will fail
 * the same way, and the cause is easier to see here.
 *
 *   cd wrds-mcp && npm install && npm run check
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = resolve(__dirname, '..', '.env');
if (existsSync(envPath)) {
  for (const raw of readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
  console.log(`config: loaded ${envPath}`);
} else {
  console.log(`config: no .env at ${envPath} — relying on the environment`);
}

const wrds = await import('../src/wrds.js');

// Reports the username and which file it came from — never the password.
const cred = wrds.credentialSource();
if (cred.found) {
  console.log(`creds:  user=${cred.user} from ${cred.source}`);
} else {
  console.log(`creds:  NOT FOUND — ${cred.error}`);
}
console.log('');

const health = await wrds.healthCheck();
console.log(JSON.stringify(health, null, 2));

if (health.connected) {
  console.log('\n--- schemas matching crsp / comp / ibes / ciq ---');
  for (const f of ['crsp', 'comp', 'ibes', 'ciq']) {
    try {
      const r = await wrds.listSchemas({ filter: f });
      const names = r.schemas.map((s) => `${s.schema}(${s.table_count})`);
      console.log(`${f.padEnd(6)} ${names.length ? names.join(', ') : 'none visible'}`);
    } catch (err) {
      console.log(`${f.padEnd(6)} error: ${err.message}`);
    }
  }
}

await wrds.closePool();
process.exit(health.connected ? 0 : 1);
