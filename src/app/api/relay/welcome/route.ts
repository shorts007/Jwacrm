// POST /api/relay/welcome   (admin+)   { agent_id }
// Sends the agent the "how to answer customers" instructions from the WhatsApp app number —
// also proves the number is right and that the agent can receive from the shop number.
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import * as evo from '@/lib/evolution/client';
import { connFromRow, loadEvolutionConfig } from '@/lib/evolution/server';
import { HELP_TEXT } from '@/lib/relay/logic';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => null)) as { agent_id?: unknown } | null;
    if (!body || typeof body.agent_id !== 'string') return NextResponse.json({ error: 'agent_id is required' }, { status: 400 });
    const { data: agent } = await supabaseAdmin()
      .from('relay_agents')
      .select('name, phone_digits')
      .eq('id', body.agent_id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    const row = await loadEvolutionConfig(ctx.accountId);
    if (!row) return NextResponse.json({ error: 'Connect the WhatsApp app number first (Engagement → Channels).' }, { status: 400 });
    await evo.sendText(
      connFromRow(row),
      agent.phone_digits as string,
      `👋 Hi ${agent.name}, you are now an agent for this shop number. Customer messages will arrive here.\n\n${HELP_TEXT}`,
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (/Evolution|reach/i.test(msg)) return NextResponse.json({ error: msg }, { status: 502 });
    return toErrorResponse(err);
  }
}
