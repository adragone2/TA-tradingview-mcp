import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as doctorCore from '../core/doctor.js';
import * as rulesCore from '../core/rules.js';

export function registerDoctorTools(server) {
  server.tool(
    'tv_doctor',
    'Run all setup checks at once: node version, TradingView install, CDP port, MCP server load, live chart read, and rules.json. Each failing check returns the exact command to fix it. Use this first when anything is not working.',
    {
      port: z.coerce.number().optional().describe('CDP port (default 9222)'),
      skip_server_test: z.coerce.boolean().optional().describe('Skip the MCP server smoke test (default false)'),
    },
    async ({ port, skip_server_test } = {}) => {
      try { return jsonResult(await doctorCore.doctor({ port, skip_server_test })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );

  server.tool(
    'rules_init',
    'Create rules.json from the bundled template so morning_brief can use your own watchlist, bias criteria, and risk rules. Safe to call — will not overwrite an existing rules.json unless force is true.',
    {
      path: z.string().optional().describe('Write to a specific path instead of the project root'),
      force: z.coerce.boolean().optional().describe('Overwrite an existing rules.json (default false)'),
    },
    async ({ path, force } = {}) => {
      try { return jsonResult(rulesCore.initRules({ path, force })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );

  server.tool(
    'rules_status',
    'Show which rules.json would be used, and where it was searched for.',
    {},
    async () => {
      try { return jsonResult(rulesCore.rulesStatus()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );
}
