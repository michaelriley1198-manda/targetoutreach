import cron from 'node-cron';
import { supabase } from '../db.js';
import { getSequenceContactProgress } from '../services/apollo.js';

// Maps Apollo step status -> our lead status
function mapApolloStatus(s) {
  const x = String(s || '').toLowerCase();
  if (x.includes('replied')) return 'connected';
  if (x.includes('opened')) return 'emailed';
  if (x.includes('sent') || x.includes('delivered')) return 'emailed';
  if (x.includes('bounced') || x.includes('unsubscribed')) return 'passed';
  if (x.includes('finished') || x.includes('completed')) return 'emailed';
  return null;
}

async function tick() {
  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('*')
    .eq('status', 'running')
    .not('apollo_sequence_id', 'is', null);
  if (!campaigns?.length) return;

  for (const campaign of campaigns) {
    const { ok, rows, error } = await getSequenceContactProgress(campaign.apollo_sequence_id);
    if (!ok) {
      console.warn(`[cron] Apollo poll failed for campaign ${campaign.id}: ${error}`);
      continue;
    }

    for (const row of rows || []) {
      const apolloContactId = row.contact_id || row.contact?.id || row.id;
      if (!apolloContactId) continue;

      const stepNum = row.current_step ?? row.step_number ?? row.position ?? null;
      const apolloStatus = row.status || row.contact_status || null;
      const mapped = mapApolloStatus(apolloStatus);

      const update = {};
      if (typeof stepNum === 'number') update.sequence_step = stepNum;
      if (mapped) update.status = mapped;
      if (Object.keys(update).length) {
        update.last_action = `apollo_${apolloStatus || 'progress'}`;
        update.last_action_date = new Date().toISOString();
        await supabase
          .from('leads')
          .update(update)
          .eq('campaign_id', campaign.id)
          .eq('apollo_contact_id', apolloContactId);
      }
    }
  }
}

export function startSequenceCron() {
  // run every hour at minute 5
  cron.schedule('5 * * * *', () => {
    tick().catch((e) => console.error('[cron] tick failed', e));
  });
  // also run once on boot (delayed, so server is ready)
  setTimeout(() => tick().catch((e) => console.error('[cron] boot tick failed', e)), 10_000);
}
