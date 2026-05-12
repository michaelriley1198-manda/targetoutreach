// One-shot diagnostic: re-run Apollo enrichment for the top 10 leads of the most
// recent commercial paving campaign that don't yet have apollo_contact_id.
// Logs the FULL findOwner result (or null + reason) and updates DB on success.
//
// Usage: node scripts/reenrich-top10.js
import 'dotenv/config';
import { supabase } from '../src/db.js';
import { findOwner } from '../src/services/apollo.js';
import axios from 'axios';

const APOLLO_BASE = 'https://api.apollo.io/api/v1';

async function rawSearchProbe(domain) {
  // Mirror what findOwner sends, but capture the full top-level response so we
  // can see what Apollo actually returned (people array, total counts, errors).
  try {
    const { data } = await axios.post(
      `${APOLLO_BASE}/mixed_people/search`,
      {
        q_organization_domains: domain,
        person_titles: ['owner', 'founder', 'co-founder', 'president', 'ceo', 'managing partner', 'managing director'],
        page: 1,
        per_page: 5,
      },
      { headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' }, timeout: 30_000 }
    );
    return {
      pagination: data?.pagination,
      total_entries: data?.pagination?.total_entries,
      people_count: (data?.people || []).length,
      contacts_count: (data?.contacts || []).length,
      first_person_titles: (data?.people || []).slice(0, 3).map((p) => p.title),
    };
  } catch (e) {
    return { error: e.response?.status + ' ' + (e.response?.data?.error || e.message) };
  }
}

function domainFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

async function main() {
  const { data: campaigns, error: cErr } = await supabase
    .from('campaigns')
    .select('id, name, created_at')
    .ilike('name', '%commercial paving%')
    .order('created_at', { ascending: false })
    .limit(1);
  if (cErr) throw new Error(`Campaign lookup failed: ${cErr.message}`);
  if (!campaigns?.length) throw new Error('No commercial paving campaign found');
  const campaign = campaigns[0];
  console.log(`Campaign: ${campaign.name} (${campaign.id})  created ${campaign.created_at}\n`);

  const { data: leads } = await supabase
    .from('leads')
    .select('id, company_name, company_url, priority_score, apollo_contact_id, contact_name')
    .eq('campaign_id', campaign.id)
    .is('apollo_contact_id', null)
    .order('priority_score', { ascending: false })
    .limit(10);

  console.log(`Top 10 unenriched leads (priority_score desc):\n`);
  for (const lead of leads || []) {
    const domain = domainFromUrl(lead.company_url);
    console.log(`[${lead.priority_score}] ${lead.company_name}  ${lead.company_url}  domain=${domain}`);
  }
  console.log('');

  let succeeded = 0;
  for (const lead of leads || []) {
    const domain = domainFromUrl(lead.company_url);
    console.log(`\n=== ${lead.company_name} (${domain}) ===`);
    const probe = await rawSearchProbe(domain);
    console.log('  raw search probe:', JSON.stringify(probe));

    const owner = await findOwner(lead.company_url);
    if (owner) {
      console.log('  FOUND:', JSON.stringify({
        name: owner.name, title: owner.title, email: owner.email,
        phone: owner.phone, apollo_contact_id: owner.apollo_contact_id,
      }));
      const { error: uErr } = await supabase
        .from('leads')
        .update({
          contact_name: owner.name || null,
          contact_title: owner.title || null,
          email: owner.email || null,
          phone: owner.phone || null,
          apollo_contact_id: owner.apollo_contact_id || null,
        })
        .eq('id', lead.id);
      if (uErr) console.log('  DB UPDATE FAILED:', uErr.message);
      else { succeeded++; console.log('  DB updated.'); }
    } else {
      console.log('  NOT FOUND (findOwner returned null)');
    }
  }

  console.log(`\n--- SUMMARY: ${succeeded}/${(leads || []).length} now have contact info ---`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
