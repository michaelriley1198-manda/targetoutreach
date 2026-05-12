// Backfill: run website + LinkedIn owner discovery for leads, write results
// into the `lead_owners` table. Non-destructive — existing lead_owners rows
// are kept (deduped by lower(name)); newly-discovered owners get inserted.
// The lead's mirror columns (contact_name/email/phone/apollo_contact_id) are
// updated to the "primary" owner (email+phone first, then email-only).
//
// Usage:
//   node scripts/rediscover-owners.js                       # all paving leads
//   node scripts/rediscover-owners.js <campaign_id>         # specific campaign
//   node scripts/rediscover-owners.js <campaign_id> <leadId,leadId,...>
import 'dotenv/config';
import { supabase } from '../src/db.js';
import { discoverOwners } from '../src/services/owners.js';

function domainFromUrl(url) {
  if (!url) return null;
  const withProto = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try { return new URL(withProto).hostname.replace(/^www\./, ''); } catch { return null; }
}

function splitFullName(name) {
  if (!name) return { first: null, last: null };
  const parts = String(name).trim().split(/\s+/);
  return { first: parts[0] || null, last: parts.length > 1 ? parts.slice(1).join(' ') : null };
}

function nameKey(n) {
  return String(n || '').toLowerCase().replace(/[^\w\s]/g, '').trim();
}

const [, , campaignArg, leadIdsArg] = process.argv;

let q = supabase.from('leads').select('id, campaign_id, company_name, company_url, contact_name, email, phone');
if (campaignArg) q = q.eq('campaign_id', campaignArg);
else q = q.in('campaign_id', (await supabase.from('campaigns').select('id').ilike('name', '%paving%')).data?.map((c) => c.id) || []);
if (leadIdsArg) q = q.in('id', leadIdsArg.split(','));
const { data: leads, error } = await q;
if (error) { console.error(error); process.exit(1); }
if (!leads?.length) { console.log('No leads matched.'); process.exit(0); }

console.log(`Running discovery on ${leads.length} lead(s).\n`);

for (const lead of leads) {
  const domain = domainFromUrl(lead.company_url);
  console.log(`\n── ${lead.company_name} (${domain || lead.company_url}) ──`);
  if (!lead.company_url) { console.log('  no company_url — skip'); continue; }

  try {
    const discovered = await discoverOwners({
      companyName: lead.company_name,
      companyUrl: lead.company_url,
      domain,
    });
    if (!discovered.length) {
      console.log('  no owners found from website + LinkedIn');
      continue;
    }

    const { data: existing } = await supabase
      .from('lead_owners')
      .select('id, name')
      .eq('lead_id', lead.id);
    const existingKeys = new Set((existing || []).map((o) => nameKey(o.name)));

    const newRows = [];
    for (const c of discovered) {
      const flags = [];
      if (c.email) flags.push('📧');
      if (c.phone) flags.push('📞');
      if (c.linkedin_url) flags.push('🔗');
      if (c.apollo_contact_id) flags.push('apollo');
      const k = nameKey(c.name);
      if (k && existingKeys.has(k)) {
        console.log(`  ↺ ${c.name}  (already in lead_owners — skip)`);
        continue;
      }
      console.log(`  ✓ ${c.name}  |  ${c.title || '?'}  |  ${flags.join(' ') || 'name only'}  |  src=${c.source}`);
      const { first, last } = splitFullName(c.name);
      newRows.push({
        lead_id: lead.id,
        name: c.name,
        first_name: c.first_name || first,
        last_name: c.last_name || last,
        title: c.title || null,
        email: c.email || null,
        phone: c.phone || null,
        linkedin_url: c.linkedin_url || null,
        sources: c.source ? [c.source] : [],
        confidence: c.confidence || null,
        apollo_contact_id: c.apollo_contact_id || null,
        enrichment_source: c.apollo_contact_id ? 'apollo' : null,
      });
    }

    if (newRows.length) {
      const { error: insErr } = await supabase.from('lead_owners').insert(newRows);
      if (insErr) console.log('  DB insert failed:', insErr.message);
      else console.log(`  inserted ${newRows.length} new owner(s)`);
    }

    // Mirror primary onto leads (only fill empties, don't clobber).
    const { data: allOwners } = await supabase
      .from('lead_owners')
      .select('*')
      .eq('lead_id', lead.id);
    const sorted = [...(allOwners || [])].sort((a, b) => {
      const aS = (a.email && a.phone) ? 3 : (a.email ? 2 : (a.phone ? 1 : 0));
      const bS = (b.email && b.phone) ? 3 : (b.email ? 2 : (b.phone ? 1 : 0));
      return bS - aS;
    });
    const primary = sorted[0];
    if (primary) {
      const mirror = {};
      if (primary.name && !lead.contact_name) mirror.contact_name = primary.name;
      if (primary.title) mirror.contact_title = primary.title;
      if (primary.email && !lead.email) mirror.email = primary.email;
      if (primary.phone && !lead.phone) mirror.phone = primary.phone;
      if (primary.apollo_contact_id) mirror.apollo_contact_id = primary.apollo_contact_id;
      if (Object.keys(mirror).length) {
        const { error: uErr } = await supabase.from('leads').update(mirror).eq('id', lead.id);
        if (uErr) console.log('  legacy mirror update failed:', uErr.message);
      }
    }
  } catch (e) {
    console.log('  discovery threw:', e.message);
  }
}

console.log('\nDone.');
process.exit(0);
