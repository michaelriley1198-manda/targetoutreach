// One-shot: trigger Apollo waterfall enrichment for any lead that has an
// apollo_contact_id but is missing email and/or phone. Apollo will deliver
// the revealed data asynchronously to /api/apollo/enrichment-webhook over
// the next few minutes. Re-runs are safe — already-populated fields are
// left untouched by the webhook handler.
//
// Usage: node scripts/trigger-waterfall.js
import 'dotenv/config';
import axios from 'axios';
import { supabase } from '../src/db.js';

const APOLLO_BASE = 'https://api.apollo.io/api/v1';
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const WEBHOOK_URL = `${PUBLIC_BASE}/api/apollo/enrichment-webhook`;

if (!PUBLIC_BASE) {
  console.error('PUBLIC_BASE_URL must be set in .env (Apollo needs it for the async callback).');
  process.exit(1);
}

function domainFromUrl(url) {
  if (!url) return null;
  const withProto = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try { return new URL(withProto).hostname.replace(/^www\./, ''); } catch { return null; }
}

const { data: leads, error } = await supabase
  .from('leads')
  .select('id, company_name, company_url, contact_name, apollo_contact_id, email, phone, contacts, primary_contact_idx')
  .not('apollo_contact_id', 'is', null)
  .or('email.is.null,phone.is.null');
if (error) { console.error(error); process.exit(1); }

console.log(`Found ${leads.length} lead(s) needing waterfall enrichment.\n`);

let queued = 0;
for (const lead of leads) {
  const domain = domainFromUrl(lead.company_url);
  // Pull the most authoritative identity we have for the primary contact.
  // Apollo's third-party phone vendors (LeadMagic, Upcell, FindyMail) match
  // better with id + linkedin_url + full name than with first_name + domain.
  const primary = Array.isArray(lead.contacts) && lead.contacts.length
    ? lead.contacts[lead.primary_contact_idx ?? 0] || lead.contacts[0]
    : null;
  const firstName = primary?.first_name || (lead.contact_name || '').split(' ')[0];
  const lastName = primary?.last_name || ((lead.contact_name || '').split(' ').slice(1).join(' ') || null);
  const linkedinUrl = primary?.linkedin_url || null;
  const apolloId = primary?.apollo_contact_id || lead.apollo_contact_id;

  if (!apolloId && (!firstName || !domain)) {
    console.log(`  SKIP ${lead.company_name}: no id and missing first_name/domain`);
    continue;
  }

  // Build the most-specific request Apollo's vendor cascade can use.
  const body = {
    webhook_url: WEBHOOK_URL,
    reveal_personal_emails: true,
    reveal_phone_number: true,
    run_waterfall_email: true,
    run_waterfall_phone: true,
  };
  if (apolloId) body.id = apolloId;
  if (firstName) body.first_name = firstName;
  if (lastName) body.last_name = lastName;
  if (domain) body.domain = domain;
  if (linkedinUrl) body.linkedin_url = linkedinUrl;

  try {
    const { data } = await axios.post(`${APOLLO_BASE}/people/match`, body, {
      headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
      timeout: 30_000,
    });
    // Apollo returns a (potentially new) contact id from each /people/match call.
    // The async webhook payload uses this id, so refresh the lead's stored id
    // (and the primary contact's apollo_contact_id) to keep them in sync.
    const newId = data?.person?.id;
    const updates = {};
    if (newId && newId !== lead.apollo_contact_id) updates.apollo_contact_id = newId;
    if (newId && primary && newId !== primary.apollo_contact_id) {
      const newContacts = [...(lead.contacts || [])];
      const idx = lead.primary_contact_idx ?? 0;
      newContacts[idx] = { ...newContacts[idx], apollo_contact_id: newId };
      updates.contacts = newContacts;
    }
    if (Object.keys(updates).length) await supabase.from('leads').update(updates).eq('id', lead.id);

    const idLabel = apolloId ? `id=${apolloId.slice(-6)}` : `${firstName} @ ${domain}`;
    const liLabel = linkedinUrl ? ' +linkedin' : '';
    console.log(`  QUEUED ${(primary?.name || firstName)} (${idLabel}${liLabel})  → new id ${newId?.slice(-6)}`);
    queued++;
  } catch (e) {
    const msg = e.response?.data?.error || e.message;
    console.log(`  FAILED ${primary?.name || firstName} @ ${domain}: ${msg}`);
  }
}
console.log(`\nQueued ${queued}/${leads.length} waterfall reveals. Webhook callbacks will trickle in over the next several minutes.`);
console.log(`Watch the server log for: [apollo/webhook] updated lead via apollo_contact_id=...`);
process.exit(0);
