// ============================================================
// POST /api/v1/lulu/customers/sync/finish   (scope: contacts:write)
//
// Call ONCE after every batch of a full run succeeded:
//   { "run_id": "<same id sent with each batch>", "force": false }
// Profiles not written by that run are marked active = false (kept for
// history, hidden from counts / dry run / campaigns). Customers who return
// in a later run are re-activated automatically.
// Refuses when the run kept < 50 % of the active profiles (partial run).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { pruneVerdict } from '@/lib/lulu/sync';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');
    const db = ctx.supabase;
    const body = (await request.json().catch(() => null)) as { run_id?: unknown; force?: unknown } | null;
    const runId = typeof body?.run_id === 'string' ? body.run_id.trim().slice(0, 64) : '';
    if (!runId) return fail('bad_request', "'run_id' is required", 400);


    const [{ count: kept, error: e1 }, { count: activeBefore, error: e2 }] = await Promise.all([
      db.from('lulu_customer_profiles').select('id', { count: 'exact', head: true })
        .eq('account_id', ctx.accountId).eq('sync_run', runId),
      db.from('lulu_customer_profiles').select('id', { count: 'exact', head: true })
        .eq('account_id', ctx.accountId).eq('active', true),
    ]);
    if (e1 || e2) {
      console.error('[lulu/sync/finish] count error:', e1 ?? e2);
      return fail('internal', 'Failed to count profiles', 500);
    }

    const verdict = pruneVerdict(kept ?? 0, activeBefore ?? 0, body?.force === true);
    if (!verdict.ok) return fail('conflict', verdict.reason, 409);

    const { data, error } = await db
      .from('lulu_customer_profiles')
      .update({ active: false })
      .eq('account_id', ctx.accountId)
      .eq('active', true)
      .or(`sync_run.is.null,sync_run.neq.${runId}`)
      .select('id');
    if (error) {
      console.error('[lulu/sync/finish] update error:', error);
      return fail('internal', 'Failed to retire stale profiles', 500);
    }

    return ok({ run_id: runId, kept: kept ?? 0, retired: data?.length ?? 0 });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
