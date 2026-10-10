// GET /api/channels/summary  (any member) — which number messages leave from, for UI hints
// (e.g. the inbox drops the 24-hour lock for chats on the WhatsApp app number). No secrets.
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { outboundSummary } from '@/lib/channels/outbound';

export async function GET() {
  try {
    const ctx = await requireRole('viewer');
    return NextResponse.json(await outboundSummary(ctx.accountId));
  } catch (err) {
    return toErrorResponse(err);
  }
}
