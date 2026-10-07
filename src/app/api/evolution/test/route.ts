// POST /api/evolution/test  { number, text }  (admin+) — send one plain message through Evolution.
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { EvolutionError, sendText } from '@/lib/evolution/client';
import { connFromRow, loadEvolutionConfig, logEvolutionEvent } from '@/lib/evolution/server';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => null)) as { number?: string; text?: string } | null;
    const number = (body?.number ?? '').replace(/\D/g, '');
    const text = (body?.text ?? '').trim() || 'Test message from WACRM via Evolution ✅';
    if (number.length < 8) return NextResponse.json({ error: 'Enter the number with country code, e.g. 966501234567.' }, { status: 400 });
    const row = await loadEvolutionConfig(ctx.accountId);
    if (!row) return NextResponse.json({ error: 'Not configured.' }, { status: 400 });
    if (row.state !== 'open') return NextResponse.json({ error: 'The number is not connected yet — scan the QR code first.' }, { status: 400 });
    try {
      const r = await sendText(connFromRow(row), number, text);
      await logEvolutionEvent(ctx.accountId, 'test_send', 'sent', { to: `${number.slice(0, 5)}…`, id: r.id });
      return NextResponse.json({ ok: true, id: r.id });
    } catch (e) {
      const msg = e instanceof EvolutionError ? e.message : String(e);
      await logEvolutionEvent(ctx.accountId, 'test_send', 'error', { error: msg });
      return NextResponse.json({ error: msg }, { status: 502 });
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
