// POST /api/evolution/logout  (admin+) — unlink the WhatsApp number from the instance.
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { EvolutionError, logout } from '@/lib/evolution/client';
import { connFromRow, loadEvolutionConfig, logEvolutionEvent } from '@/lib/evolution/server';

export async function POST() {
  try {
    const ctx = await requireRole('admin');
    const row = await loadEvolutionConfig(ctx.accountId);
    if (!row) return NextResponse.json({ error: 'Not configured.' }, { status: 400 });
    try {
      await logout(connFromRow(row));
    } catch (e) {
      if (!(e instanceof EvolutionError && e.status === 404)) {
        return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
      }
    }
    await supabaseAdmin()
      .from('evolution_config')
      .update({ state: 'close', qr_code: null, is_default_outbound: false, updated_at: new Date().toISOString() })
      .eq('account_id', ctx.accountId);
    await logEvolutionEvent(ctx.accountId, 'logout', 'ok');
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
