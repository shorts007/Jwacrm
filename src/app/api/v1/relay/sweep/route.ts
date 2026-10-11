// POST /api/v1/relay/sweep   (scope: messages:send)
// Agent relay housekeeping, called every 1–2 minutes by n8n (docs/lulu/n8n/relay-sweep.workflow.json):
// hands chats to another on-duty agent after N minutes without a reply, assigns chats that
// arrived while nobody was on duty, reminds the agent when nobody else is free, and closes
// chats idle for 24 h. It also runs on incoming WhatsApp traffic (at most once a minute).
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { sweep } from '@/lib/relay/server';

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'messages:send');
    const result = await sweep(ctx.accountId, { force: true });
    return ok(result ?? { skipped: 'agent relay is off' });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
