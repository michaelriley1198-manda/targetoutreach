import express from 'express';
import axios from 'axios';
import { supabase } from '../db.js';

export const leadsRouter = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

leadsRouter.patch('/:id', wrap(async (req, res) => {
  const allowed = ['priority_score', 'status', 'fit_score', 'flags', 'fit_rationale', 'sequence_step', 'phone', 'email', 'contact_name', 'contact_title', 'contacts', 'primary_contact_idx'];
  const update = {};
  for (const k of allowed) if (k in (req.body || {})) update[k] = req.body[k];
  if (!Object.keys(update).length) return res.status(400).json({ error: 'No updatable fields provided' });

  const { data, error } = await supabase
    .from('leads')
    .update(update)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: `Update failed: ${error.message}` });
  res.json(data);
}));

// ----- lead_owners endpoints --------------------------------------------------

// PATCH a single owner row. The Owners tab uses this for inline edits to
// status / sequence_step. Any edit here flips stage_overridden_at to now() so
// the Apollo sync can respect the user's manual position.
export const leadOwnersRouter = express.Router();

leadOwnersRouter.patch('/:id', wrap(async (req, res) => {
  const allowed = [
    'status', 'sequence_step', 'last_action', 'last_action_date',
    'name', 'first_name', 'last_name', 'title',
    'email', 'phone', 'linkedin_url',
  ];
  const stageFields = new Set(['status', 'sequence_step']);
  const update = {};
  let stageEdited = false;
  for (const k of allowed) {
    if (k in (req.body || {})) {
      update[k] = req.body[k];
      if (stageFields.has(k)) stageEdited = true;
    }
  }
  if (!Object.keys(update).length) return res.status(400).json({ error: 'No updatable fields provided' });
  if (stageEdited) update.stage_overridden_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('lead_owners')
    .update(update)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: `Update failed: ${error.message}` });
  res.json(data);
}));

leadOwnersRouter.delete('/:id', wrap(async (req, res) => {
  const { error } = await supabase.from('lead_owners').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: `Delete failed: ${error.message}` });
  res.json({ ok: true });
}));

// Flat owner-level view for the Owners tab — joins each owner with its lead's
// company info so the table can render in one query.
leadOwnersRouter.get('/by-campaign/:campaignId', wrap(async (req, res) => {
  const { data: leads, error: lErr } = await supabase
    .from('leads')
    .select('id, company_name, company_url, priority_score, pass_fail, industry, location, sequence_step')
    .eq('campaign_id', req.params.campaignId);
  if (lErr) return res.status(500).json({ error: `Leads load failed: ${lErr.message}` });

  const visible = (leads || []).filter((l) => l.pass_fail !== 'FAIL');
  if (!visible.length) return res.json({ owners: [] });

  const leadById = new Map(visible.map((l) => [l.id, l]));
  const { data: owners, error: oErr } = await supabase
    .from('lead_owners')
    .select('*')
    .in('lead_id', visible.map((l) => l.id))
    .order('created_at', { ascending: true });
  if (oErr) return res.status(500).json({ error: `Owners load failed: ${oErr.message}` });

  const flat = (owners || []).map((o) => {
    const l = leadById.get(o.lead_id) || {};
    return {
      ...o,
      company_name: l.company_name,
      company_url: l.company_url,
      priority_score: l.priority_score,
      industry: l.industry,
      location: l.location,
    };
  });
  res.json({ owners: flat });
}));

leadsRouter.delete('/:id', wrap(async (req, res) => {
  const { error } = await supabase.from('leads').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: `Delete failed: ${error.message}` });
  res.json({ ok: true });
}));

// Lazy fetch: pull all employees Apollo has at the lead's domain. Used by the
// "Key Team Members" section in the lead profile so users can see the broader
// org context without bloating the lead record. Cached per request — no DB write.
leadsRouter.get('/:id/team', wrap(async (req, res) => {
  const { data: lead, error } = await supabase
    .from('leads')
    .select('company_url, company_name')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: `Lead not found: ${error.message}` });

  let domain = null;
  try {
    const u = lead.company_url || '';
    const withProto = /^https?:\/\//i.test(u) ? u : `https://${u}`;
    domain = new URL(withProto).hostname.replace(/^www\./, '');
  } catch {}
  if (!domain) return res.json({ team: [] });

  try {
    const { data } = await axios.post(
      'https://api.apollo.io/api/v1/mixed_people/api_search',
      { q_organization_domains: domain, page: 1, per_page: 25 },
      { headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' }, timeout: 30_000 }
    );
    const team = (data?.people || []).map((p) => ({
      apollo_contact_id: p.id,
      name: p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim(),
      first_name: p.first_name || null,
      last_name: p.last_name || null,
      title: p.title || null,
      linkedin_url: p.linkedin_url || null,
      photo_url: p.photo_url || null,
    }));
    res.json({ team });
  } catch (e) {
    res.json({ team: [], error: e.response?.data?.error || e.message });
  }
}));

leadsRouter.get('/:id/bio', wrap(async (req, res) => {
  const { data: lead, error } = await supabase
    .from('leads')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: `Lead not found: ${error.message}` });

  const { data: calls } = await supabase
    .from('call_logs')
    .select('*')
    .eq('lead_id', req.params.id)
    .order('timestamp', { ascending: false });

  res.json({ ...lead, call_logs: calls || [] });
}));
