// ============================================================
// POST /api/v1/lulu/insights/sync   (scope: contacts:write)
//
// Stores the latest BigQuery insights snapshot (lulu_insights_metrics view)
// for the account, replacing the previous one in a single upsert.
// Body: { "rows": [ { grp, period, dim, dim_value, metric, value }, … ] }
// Aggregates only — no personal data.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { MAX_INSIGHT_ROWS, dataAsOf, parseInsightRows } from '@/lib/lulu/insights';

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');
    const body = (await request.json().catch(() => null)) as { rows?: unknown } | null;
    if (!body || !Array.isArray(body.rows) || body.rows.length === 0) {
      return fail('bad_request', "Body must be { rows: [...] } with at least one row", 400);
    }
    if (body.rows.length > MAX_INSIGHT_ROWS) {
      return fail('bad_request', `Too many rows (max ${MAX_INSIGHT_ROWS})`, 400);
    }

    const { rows, rejected } = parseInsightRows(body.rows);
    if (rows.length === 0) return fail('bad_request', 'No valid rows', 400);

    const asOf = dataAsOf(rows);
    const { error } = await ctx.supabase.from('lulu_insights_snapshot').upsert(
      {
        account_id: ctx.accountId,
        rows,
        row_count: rows.length,
        data_as_of: asOf && !Number.isNaN(Date.parse(asOf)) ? asOf : null,
        synced_at: new Date().toISOString(),
      },
      { onConflict: 'account_id' }
    );
    if (error) {
      console.error('[api/v1/lulu/insights/sync] upsert error:', error);
      return fail('internal', 'Failed to save insights', 500);
    }
    return ok({ saved: rows.length, rejected, data_as_of: asOf });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
