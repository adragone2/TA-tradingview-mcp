#!/usr/bin/env node
/**
 * Regenerate docs/tools-reference.md from the LIVE server.
 *
 * Hand-maintained tool lists rot: this repo shipped a CLAUDE.md claiming 68
 * tools and server instructions claiming 78 while 100 were registered, so any
 * session reading the docs was working from a stale picture. Generating the
 * inventory means the count and the names cannot drift again.
 *
 *   node scripts/gen-tools-doc.js
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'src', 'server.js');
const OUT = join(ROOT, 'docs', 'tools-reference.md');

// Ordered so the reference reads roughly in the order a session needs things.
const ORDER = ['tv', 'rules', 'chart', 'data', 'quote', 'depth', 'symbol', 'indicator',
  'draw', 'walls', 'ta', 'morning', 'session', 'watchlist', 'layout', 'pane', 'tab',
  'pine', 'replay', 'alert', 'batch', 'capture', 'ui'];

function listTools() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [SERVER], { cwd: ROOT, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('server did not answer tools/list within 40s')); }, 40000);

    child.stdout.on('data', (d) => {
      out += d.toString();
      for (const line of out.split('\n')) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2 && msg.result?.tools) {
          clearTimeout(timer);
          child.kill();
          resolvePromise(msg.result.tools);
          return;
        }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gen-docs', version: '1' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  });
}

const tools = await listTools();

const groups = {};
for (const t of tools) {
  const g = t.name.split('_')[0];
  (groups[g] = groups[g] || []).push(t);
}
const names = [...ORDER.filter((g) => groups[g]), ...Object.keys(groups).filter((g) => !ORDER.includes(g))];

let body = '';
for (const g of names) {
  body += `\n### ${g}_* (${groups[g].length})\n\n`;
  for (const t of groups[g]) {
    const first = String(t.description || '').split('. ')[0].slice(0, 150);
    body += `- **\`${t.name}\`** — ${first}\n`;
  }
}

writeFileSync(OUT, `# Tools Reference

All **${tools.length} tools** exposed by this MCP server, generated from the live server so it cannot drift from what is actually registered.

Grouped by prefix. For *when* to use these rather than *what they are*, see
[START-HERE.md](START-HERE.md) and [routines.md](routines.md).

> **Before acting on anything that changes state**, read the guardrails in
> [START-HERE.md](START-HERE.md). Several of these tools drive the user's live
> chart or create real account objects.

## The ones that matter most

| Tool | Why |
|---|---|
| \`tv_doctor\` | First stop for any failure; every failing check carries its fix |
| \`ta_trading_context\` | Position + catalyst + regime for a ticker, in one call, before you act on a setup |
| \`draw_trade_plan\` | Entry/stop/targets in one call with R:R — never hand-build from \`draw_shape\` |
| \`walls_apply\` | TA's gamma walls into the Institutional Matrix indicator |
| \`morning_brief\` | Multi-timeframe technical scan graded against the user's own rules |
| \`ta_regime\` | Regime **and** position sizing (\`max_new_position_pct\`, \`position_multiplier\`) |

## Full inventory
${body}
---

## Not in this server

- **WRDS** research tools (\`wrds_*\`) live in the separate \`wrds-mcp\` server — see [data-sources.md](data-sources.md).
- **FSI plugin skills** are invoked by name, not as MCP tools — see [plugins.md](plugins.md).

## Regenerating

This file is generated from the running server, so it stays honest:

\`\`\`bash
node scripts/gen-tools-doc.js
\`\`\`
`);

console.log(`docs/tools-reference.md — ${tools.length} tools across ${names.length} groups`);
