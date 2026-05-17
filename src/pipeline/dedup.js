import { supabase } from '../db.js';

function normalizeDomain(domain) {
  return (domain || '').toLowerCase().replace(/^www\./, '').replace(/\/$/, '').trim();
}

// Deduplicate leads within a campaign by domain, then deduplicate owners by
// email. Called automatically in the pipeline before owner discovery, and
// available on-demand via POST /api/campaigns/:id/deduplicate.
//
// Domain dedup: for each group of leads sharing the same domain, keep the
// highest-scoring one and delete the rest (cascade removes their owners).
//
// Email dedup: after enrichment, owners sharing the same email within a
// campaign are collapsed — keep the one on the highest-scoring lead, delete
// the rest.
export async function deduplicateCampaign(campaignId) {
  const result = { leadsRemoved: 0, ownersRemoved: 0 };

  // ---- Domain dedup ---------------------------------------------------------
  const { data: leads } = await supabase
    .from('leads')
    .select('id, domain, company_url, priority_score')
    .eq('campaign_id', campaignId)
    .limit(5000);

  if (!leads?.length) return result;

  const byDomain = new Map();
  for (const lead of leads) {
    const domain = normalizeDomain(lead.domain || lead.company_url);
    if (!domain) continue;
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(lead);
  }

  const toDelete = [];
  for (const group of byDomain.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0));
    toDelete.push(...group.slice(1).map((l) => l.id));
  }

  if (toDelete.length) {
    const { error } = await supabase.from('leads').delete().in('id', toDelete);
    if (error) console.warn('[dedup] domain dedup failed:', error.message);
    else result.leadsRemoved = toDelete.length;
  }

  // ---- Email dedup (owners) -------------------------------------------------
  const { data: freshLeads } = await supabase
    .from('leads')
    .select('id, priority_score')
    .eq('campaign_id', campaignId)
    .limit(5000);
  if (!freshLeads?.length) return result;

  const leadIds = freshLeads.map((l) => l.id);
  const scoreById = Object.fromEntries(freshLeads.map((l) => [l.id, l.priority_score ?? 0]));

  const BATCH = 100;
  const ownerBatches = await Promise.all(
    Array.from({ length: Math.ceil(leadIds.length / BATCH) }, (_, i) =>
      supabase
        .from('lead_owners')
        .select('id, lead_id, email')
        .in('lead_id', leadIds.slice(i * BATCH, (i + 1) * BATCH))
        .not('email', 'is', null)
    )
  );
  const owners = ownerBatches.flatMap((b) => b.data || []);

  const byEmail = new Map();
  for (const o of owners) {
    const email = (o.email || '').toLowerCase().trim();
    if (!email) continue;
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email).push(o);
  }

  const ownerDups = [];
  for (const group of byEmail.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => (scoreById[b.lead_id] ?? 0) - (scoreById[a.lead_id] ?? 0));
    ownerDups.push(...group.slice(1).map((o) => o.id));
  }

  if (ownerDups.length) {
    const { error } = await supabase.from('lead_owners').delete().in('id', ownerDups);
    if (error) console.warn('[dedup] email dedup failed:', error.message);
    else result.ownersRemoved = ownerDups.length;
  }

  if (result.leadsRemoved || result.ownersRemoved) {
    console.log(`[dedup] campaign ${campaignId}: removed ${result.leadsRemoved} duplicate leads, ${result.ownersRemoved} duplicate owners`);
  }

  return result;
}
