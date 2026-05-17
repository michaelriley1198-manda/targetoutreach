import express from 'express';
import { supabase } from '../db.js';
import { generatePromptsForCampaign, launchCampaign } from '../pipeline/run.js';
import { deduplicateCampaign } from '../pipeline/dedup.js';
import { getProgress } from '../pipeline/progress.js';
import { synthesizeVoicemail, renderScript, audioFileExists, synthesizeAnnouncement, announceFileExists, audioPathForLead } from '../services/elevenlabs.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { setSequenceActive, archiveSequence, getContactById } from '../services/apollo.js';
import { fallbackContact as leadMagicFallback } from '../services/leadmagic.js';
import { requestContacts as shRequestContacts } from '../services/signalhire.js';

export const campaignsRouter = express.Router();

// Wrap async handlers so thrown errors land on the central error middleware
// with a JSON body. Without this, async throws hang the request.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// wait_days is relative to the previous step
const DEFAULT_SEQUENCE = [
  { type: 'call', wait_days: 0, active: true, label: 'Initial call' },
  { type: 'call', wait_days: 3, active: true, label: 'Follow-up call' },
  { type: 'call', wait_days: 5, active: true, label: 'Final call' },
];

const DEFAULT_VM_SCRIPT = "Hi [FIRST_NAME], this is Michael calling about [COMPANY]. I lead acquisitions at Boyne Capital and wanted to connect briefly about a potential opportunity. I'll follow up — thanks.";

// ---------- create / list ----------

campaignsRouter.post('/', wrap(async (req, res) => {
  const {
    name, prompt, sequence_config, vm_script,
    target_lead_count, min_priority_score, max_search_batches,
    lead_sources, apollo_filter_json, apollo_list_id, apollo_list_name,
  } = req.body || {};
  if (!name || !prompt) return res.status(400).json({ error: 'name and prompt required' });

  const insertRow = {
    name,
    prompt,
    status: 'paused',
    sequence_config: sequence_config?.length ? sequence_config : DEFAULT_SEQUENCE,
    vm_script: vm_script || DEFAULT_VM_SCRIPT,
  };
  if (Number.isInteger(target_lead_count)) insertRow.target_lead_count = target_lead_count;
  if (Number.isInteger(min_priority_score)) insertRow.min_priority_score = min_priority_score;
  if (Number.isInteger(max_search_batches)) insertRow.max_search_batches = max_search_batches;
  if (Array.isArray(req.body?.excluded_acquirers)) insertRow.excluded_acquirers = req.body.excluded_acquirers;
  if (typeof req.body?.require_independent === 'boolean') insertRow.require_independent = req.body.require_independent;
  if (Array.isArray(lead_sources) && lead_sources.length) insertRow.lead_sources = lead_sources;
  if (apollo_filter_json) insertRow.apollo_filter_json = apollo_filter_json;
  if (apollo_list_id) insertRow.apollo_list_id = apollo_list_id;
  if (apollo_list_name) insertRow.apollo_list_name = apollo_list_name;

  const { data, error } = await supabase
    .from('campaigns')
    .insert(insertRow)
    .select()
    .single();
  if (error) return res.status(500).json({ error: `Create failed: ${error.message}` });
  res.json(data);
}));

campaignsRouter.get('/', wrap(async (req, res) => {
  const { data: campaigns, error } = await supabase
    .from('campaigns')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: `List failed: ${error.message}` });

  const ids = campaigns.map((c) => c.id);
  let stats = {};
  if (ids.length) {
    const { data: leads } = await supabase
      .from('leads')
      .select('campaign_id, status, pass_fail')
      .in('campaign_id', ids);
    for (const id of ids) stats[id] = { leads: 0, reached: 0, connected: 0 };
    for (const l of leads || []) {
      if (l.pass_fail === 'FAIL') continue;
      const s = stats[l.campaign_id];
      if (!s) continue;
      s.leads++;
      if (['emailed', 'called', 'voicemail', 'connected', 'meeting'].includes(l.status)) s.reached++;
      if (['connected', 'meeting'].includes(l.status)) s.connected++;
    }
  }
  res.json(campaigns.map((c) => ({ ...c, stats: stats[c.id] || { leads: 0, reached: 0, connected: 0 } })));
}));

campaignsRouter.get('/:id', wrap(async (req, res) => {
  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: `Campaign not found: ${error.message}` });

  const { data: leads, error: leadsErr } = await supabase
    .from('leads')
    .select('*')
    .eq('campaign_id', req.params.id)
    .order('priority_score', { ascending: false });
  if (leadsErr) return res.status(500).json({ error: `Leads load failed: ${leadsErr.message}` });

  const visible = (leads || []).filter((l) => l.pass_fail !== 'FAIL');

  // Attach lead_owners per lead so the dashboard can render the multi-owner
  // section without an extra round-trip. The Owners tab uses the same data,
  // joined flat with company info.
  let ownersByLead = new Map();
  if (visible.length) {
    const { data: owners } = await supabase
      .from('lead_owners')
      .select('*')
      .in('lead_id', visible.map((l) => l.id));
    for (const o of owners || []) {
      if (!ownersByLead.has(o.lead_id)) ownersByLead.set(o.lead_id, []);
      ownersByLead.get(o.lead_id).push(o);
    }
  }
  for (const l of visible) l.owners = ownersByLead.get(l.id) || [];

  res.json({ ...campaign, leads: visible });
}));

campaignsRouter.patch('/:id', wrap(async (req, res) => {
  const allowed = [
    'name', 'status', 'sequence_config', 'email_templates', 'vm_script', 'vm_scripts', 'prompt',
    'target_lead_count', 'min_priority_score', 'max_search_batches',
    'excluded_acquirers', 'require_independent',
    'lead_sources', 'apollo_filter_json', 'apollo_list_id', 'apollo_list_name',
  ];
  const update = {};
  for (const k of allowed) if (k in (req.body || {})) update[k] = req.body[k];
  if (!Object.keys(update).length) return res.status(400).json({ error: 'No updatable fields provided' });

  const { data, error } = await supabase
    .from('campaigns')
    .update(update)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: `Update failed: ${error.message}` });

  // If the voicemail script changed, purge cached audio so leads re-synthesize on next dial.
  if ('vm_script' in update || 'vm_scripts' in update) {
    const { data: leads } = await supabase.from('leads').select('id').eq('campaign_id', req.params.id);
    for (const lead of leads || []) {
      const p = audioPathForLead(lead.id);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }

  res.json(data);
}));

// Re-fire Apollo's async waterfall reveal for every owner in this campaign
// that's still missing email or phone. The launch pipeline already runs this
// once per owner — this manual button is for owners that came in via late
// edits or the rediscover-owners script. Results land at
// /api/apollo/enrichment-webhook over the next several minutes.
campaignsRouter.post('/:id/reveal-contacts', wrap(async (req, res) => {
  const { data: leads } = await supabase
    .from('leads')
    .select('id, company_url, phone, email')
    .eq('campaign_id', req.params.id)
    .neq('pass_fail', 'FAIL');
  if (!leads?.length) return res.json({ ok: true, queued: 0, total: 0, message: 'No leads in this campaign yet' });

  const leadById = new Map(leads.map((l) => [l.id, l]));

  // Batch .in() to avoid URL-length limits on large campaigns (PostgREST GET limit).
  const BATCH = 100;
  const leadIds = leads.map((l) => l.id);
  const ownerBatches = await Promise.all(
    Array.from({ length: Math.ceil(leadIds.length / BATCH) }, (_, i) =>
      supabase
        .from('lead_owners')
        .select('id, lead_id, first_name, last_name, apollo_contact_id, linkedin_url, email, phone, phone_status, email_status')
        .in('lead_id', leadIds.slice(i * BATCH, (i + 1) * BATCH))
        .or('email.is.null,phone.is.null')
    )
  );
  const batchError = ownerBatches.find((b) => b.error)?.error;
  if (batchError) return res.status(500).json({ error: `Owners lookup failed: ${batchError.message}` });
  const owners = ownerBatches.flatMap((b) => b.data || []);
  if (!owners.length) return res.json({ ok: true, queued: 0, total: 0, message: 'All owners already have email and phone' });

  function domainFromUrl(url) {
    if (!url) return null;
    const withProto = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    try { return new URL(withProto).hostname.replace(/^www\./, ''); } catch { return null; }
  }

  async function mirrorToLead(leadId, { phone, email, phone_status, email_status } = {}) {
    const lead = leadById.get(leadId);
    if (!lead) return;
    const patch = {};
    if (phone && !lead.phone) { patch.phone = phone; if (phone_status) patch.phone_status = phone_status; }
    if (email && !lead.email) { patch.email = email; if (email_status) patch.email_status = email_status; }
    if (!Object.keys(patch).length) return;
    Object.assign(lead, patch);
    await supabase.from('leads').update(patch).eq('id', leadId);
  }

  const CONCURRENCY = 8;
  let queued = 0, skipped = 0;

  async function fireOne(owner) {
    const lead = leadById.get(owner.lead_id);
    const domain = domainFromUrl(lead?.company_url);
    if (!owner.first_name || !owner.last_name || !domain) { skipped++; return; }

    // Apollo cached email (free) — try before spending LeadMagic credits.
    let prefilledEmail = null;
    if (!owner.email && owner.apollo_contact_id) {
      const r = await getContactById(owner.apollo_contact_id).catch(() => null);
      if (r?.email) {
        prefilledEmail = r.email;
        const patch = { email: r.email, email_status: 'apollo_cached' };
        await supabase.from('lead_owners').update(patch).eq('id', owner.id);
        Object.assign(owner, patch);
        await mirrorToLead(owner.lead_id, patch);
      }
    }

    const lm = await leadMagicFallback(owner, { companyDomain: domain, prefilledEmail }).catch(() => null);
    if (lm) {
      await supabase.from('lead_owners').update(lm).eq('id', owner.id);
      Object.assign(owner, lm);
      await mirrorToLead(owner.lead_id, lm);
    }
    queued++;
  }

  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, owners.length) }, async () => {
      while (i < owners.length) {
        const owner = owners[i++];
        await fireOne(owner);
      }
    })
  );

  // Signal Hire pass — async webhook, for owners still missing phone after LeadMagic.
  // Uses linkedin_url or email as the lookup identifier; results arrive via webhook.
  let shQueued = 0;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (process.env.SIGNALHIRE_API_KEY && base) {
    const shTargets = owners
      .filter((o) => !o.phone && (o.linkedin_url || o.email));
    if (shTargets.length) {
      const callbackUrl = `${base}/api/signalhire/webhook`;
      // Batch into groups of 100 (Signal Hire limit per request)
      for (let j = 0; j < shTargets.length; j += 100) {
        const batch = shTargets.slice(j, j + 100);
        const items = batch.map((o) => o.linkedin_url || o.email);
        await shRequestContacts(items, callbackUrl).catch(() => null);
        shQueued += batch.length;
      }
    }
  }

  res.json({
    ok: true,
    total: owners.length,
    queued,
    skipped,
    shQueued,
    message: `LeadMagic: processed ${queued}/${owners.length} owners.${shQueued ? ` Signal Hire queued ${shQueued} for phone — results arrive via webhook.` : ''} Refresh to see updated contacts.`,
  });
}));

// On-demand dedup: remove duplicate leads (same domain) and duplicate owners
// (same email) within a campaign.
campaignsRouter.post('/:id/deduplicate', wrap(async (req, res) => {
  const result = await deduplicateCampaign(req.params.id);
  res.json({ ok: true, ...result });
}));

// Delete a campaign: deactivate + archive in Apollo, then remove our row (cascade
// drops leads + call_logs via FK). Best-effort on Apollo side — if the API call
// fails, we still remove the local row so the dashboard isn't left in a stuck state.
campaignsRouter.delete('/:id', wrap(async (req, res) => {
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, apollo_sequence_id')
    .eq('id', req.params.id)
    .single();
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  if (campaign.apollo_sequence_id) {
    // Abort first (so no more sends fire during the archive transition), then archive.
    const abortR = await setSequenceActive(campaign.apollo_sequence_id, false);
    if (!abortR.ok) console.warn('[campaigns] Apollo abort-on-delete failed', abortR.error);
    const archR = await archiveSequence(campaign.apollo_sequence_id);
    if (!archR.ok) console.warn('[campaigns] Apollo archive-on-delete failed', archR.error);
  }

  const { error } = await supabase.from('campaigns').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: `Delete failed: ${error.message}` });
  res.json({ ok: true });
}));

// ---------- prompt generation + launch ----------

campaignsRouter.post('/:id/generate-prompts', wrap(async (req, res) => {
  try {
    const queries = await generatePromptsForCampaign(req.params.id);
    res.json({ queries });
  } catch (e) {
    res.status(500).json({ error: `Prompt generation failed: ${e.message}` });
  }
}));

campaignsRouter.post('/:id/launch', wrap(async (req, res) => {
  // fire and forget — long-running pipeline runs in the background
  const queries = req.body?.queries || null;
  const skipEnrichment = !!req.body?.skip_enrichment;
  const opts = {
    skipEnrichment,
    csvStagingId: req.body?.csv_staging_id || null,
  };
  res.json({ ok: true, message: 'Campaign launching in background', skip_enrichment: skipEnrichment });
  launchCampaign(req.params.id, queries, opts).catch((e) => {
    console.error('[launch] failed', req.params.id, e);
  });
}));

campaignsRouter.get('/:id/progress', (req, res) => {
  const p = getProgress(req.params.id);
  res.json(p || { stage: null });
});

// ---------- call queue + dialer ----------

campaignsRouter.get('/:id/call-queue', wrap(async (req, res) => {
  // Leads whose current sequence step is a call and which haven't been called for it yet.
  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: `Campaign not found: ${error.message}` });

  const seq = campaign.sequence_config || [];
  const { data: leads } = await supabase
    .from('leads')
    .select('*')
    .eq('campaign_id', req.params.id)
    .order('priority_score', { ascending: false });

  const now = Date.now();
  const queue = (leads || []).filter((l) => {
    if (!l.phone) return false;
    if (l.pass_fail === 'FAIL') return false;
    const step = seq[l.sequence_step];
    if (!step || !step.active || step.type !== 'call') return false;
    if (l.status === 'connected' || l.status === 'meeting' || l.status === 'passed') return false;
    if (step.wait_days > 0 && l.last_action_date) {
      const daysSince = (now - new Date(l.last_action_date)) / 86_400_000;
      if (daysSince < step.wait_days) return false;
    }
    return true;
  }).map((l) => {
    const step = seq[l.sequence_step];
    const totalSteps = seq.length;
    return { ...l, _step_index: l.sequence_step, _total_steps: totalSteps, _step_label: step?.label };
  });

  res.json({ queue });
}));

// Session prep for the browser dialer. The browser SDK places the outbound
// call itself — this endpoint pre-synthesizes the audio assets (announcement
// + per-lead voicemail) and returns the prepared queue with a session_id used
// to route SSE events back to this dialer instance.
campaignsRouter.post('/:id/dial', wrap(async (req, res) => {
  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: error.message });

  const { data: leads } = await supabase
    .from('leads')
    .select('*')
    .eq('campaign_id', req.params.id)
    .order('priority_score', { ascending: false });

  const seq = campaign.sequence_config || [];
  const nowMs = Date.now();
  const queue = (leads || []).filter((l) => {
    if (!l.phone) return false;
    if (l.pass_fail === 'FAIL') return false;
    const step = seq[l.sequence_step];
    if (!step?.active || step.type !== 'call') return false;
    if (['connected', 'meeting', 'passed'].includes(l.status)) return false;
    if (step.wait_days > 0 && l.last_action_date) {
      const daysSince = (nowMs - new Date(l.last_action_date)) / 86_400_000;
      if (daysSince < step.wait_days) return false;
    }
    return true;
  });

  const leadIds = (req.body?.lead_ids && Array.isArray(req.body.lead_ids))
    ? req.body.lead_ids
    : queue.map((l) => l.id);
  const targets = queue.filter((l) => leadIds.includes(l.id));
  if (!targets.length) return res.json({ ok: true, session_id: null, leads: [] });

  function vmScriptFor(lead) {
    const callsBefore = seq.slice(0, lead.sequence_step + 1).filter((s) => s?.type === 'call').length;
    const callOrdinal = Math.max(0, callsBefore - 1);
    const arr = campaign.vm_scripts || [];
    return arr[callOrdinal] || arr[0] || campaign.vm_script || '';
  }

  for (const lead of targets) {
    try {
      if (!audioFileExists(lead.id)) {
        const firstName = (lead.contact_name || '').split(' ')[0] || 'there';
        const tpl = vmScriptFor(lead);
        const text = renderScript(tpl, {
          FIRST_NAME: firstName,
          COMPANY: lead.company_name || '',
          INDUSTRY: lead.industry || '',
          CONTACT_NAME: lead.contact_name || '',
        });
        if (text) await synthesizeVoicemail(lead.id, text);
      }
      if (!announceFileExists(lead.id)) {
        await synthesizeAnnouncement(lead.id, lead);
      }
    } catch (e) {
      console.warn('[dial] audio synth failed', lead.id, e.message);
    }
  }

  const session_id = crypto.randomUUID();
  res.json({ ok: true, session_id, leads: targets });
}));

// PATCH outcome from the LogOutcomeModal after a connected call. Keyed by
// the dialed-leg Twilio Call SID (which the browser SDK exposes on disconnect).
campaignsRouter.patch('/call-logs/:callSid/outcome', wrap(async (req, res) => {
  const { outcome_label, notes, talk_seconds } = req.body || {};
  const update = {};
  if (outcome_label) update.outcome_label = outcome_label;
  if (typeof notes === 'string') update.notes = notes;
  if (Number.isFinite(talk_seconds)) update.talk_seconds = talk_seconds;
  if (!Object.keys(update).length) return res.status(400).json({ error: 'no fields to update' });

  const { data: existing } = await supabase
    .from('call_logs')
    .select('id')
    .eq('twilio_call_sid', req.params.callSid)
    .maybeSingle();
  if (existing?.id) {
    const { error: e } = await supabase.from('call_logs').update(update).eq('id', existing.id);
    if (e) return res.status(500).json({ error: e.message });
  } else {
    // Status callback hasn't landed yet — create a placeholder with the sid
    // so the future status row finds & updates this one instead of duplicating.
    const { error: e } = await supabase.from('call_logs').insert({
      twilio_call_sid: req.params.callSid,
      ...update,
    });
    if (e) return res.status(500).json({ error: e.message });
  }
  res.json({ ok: true });
}));
