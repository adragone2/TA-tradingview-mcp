import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool(
    'alert_create',
    "Create a price alert on the user's TradingView account, through the same REST API the alert dialog uses. Creates a real alert that can fire and notify — check the price is on the correct side of spot before calling, since an alert placed at or past the current price fires immediately.",
    {
      price: z.coerce.number().describe('Price level for the alert'),
      condition: z.enum(['crossing', 'crossing_up', 'crossing_down', 'greater_than', 'less_than']).optional()
        .describe('Trigger condition (default "crossing")'),
      symbol: z.string().optional().describe('Symbol to alert on (defaults to the chart\'s current symbol)'),
      message: z.string().optional().describe('Alert message (defaults to "<SYMBOL> <condition> <price>")'),
      resolution: z.string().optional().describe('Timeframe the condition is evaluated on (default "1")'),
      expiration_days: z.coerce.number().optional().describe('Days until the alert expires (default 30)'),
      notify: z.object({
        popup: z.coerce.boolean().optional().describe('Show a popup (default true)'),
        email: z.coerce.boolean().optional().describe('Send email (default false)'),
        mobile_push: z.coerce.boolean().optional().describe('Send mobile push (default false)'),
        web_hook: z.string().optional().describe('Webhook URL'),
      }).optional().describe('Notification channels'),
    },
    async (args) => {
      try { return jsonResult(await core.create(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );

  server.tool(
    'alert_list',
    'List the alerts on the account, with their ids, symbols, conditions and active state. Get alert_ids from here before deleting.',
    {},
    async () => {
      try { return jsonResult(await core.list()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );

  server.tool(
    'alert_delete',
    "Delete alerts by id. Deleting is permanent and these are the user's real alerts — always pass explicit alert_ids from alert_list. Only use delete_all when the user has clearly asked to remove every alert, and confirm first.",
    {
      alert_ids: z.array(z.coerce.number()).optional().describe('Alert ids to delete (from alert_list)'),
      delete_all: z.coerce.boolean().optional().describe('Delete every alert on the account — destructive, confirm with the user first'),
    },
    async ({ alert_ids, delete_all }) => {
      try { return jsonResult(await core.deleteAlerts({ alert_ids, delete_all })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );
}
