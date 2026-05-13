import axios from 'axios';

const BASE = 'https://api.apollo.io/api/v1';
const TIMEOUT = 30_000;

function headers() {
  return {
    'X-Api-Key': process.env.APOLLO_API_KEY,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
  };
}

const OWNER_TITLES = ['owner', 'founder', 'co-founder', 'president', 'ceo', 'managing partner', 'managing director'];

function domainFromUrl(url) {
  if (!url) return null;
  // Tolerate naked domains ("crownpave.com") by adding a protocol before parsing.
  const withProto = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    return new URL(withProto).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function apolloErr(e) {
  const status = e.response?.status;
  const body = e.response?.data;
  const msg = body?.error || body?.errors?.[0]?.message || body?.message || e.message;
  return status ? `${status} ${msg}` : msg;
}

// ----------------------------------------------------------------------------
// Direct contact fetch — reads whatever Apollo already has stored (including
// manually-unlocked phones). Zero credits; call before any waterfall attempt.
// ----------------------------------------------------------------------------
export async function getContactById(contactId) {
  if (!contactId) return null;
  try {
    const { data } = await axios.get(`${BASE}/contacts/${contactId}`,
      { headers: headers(), timeout: TIMEOUT });
    const c = data?.contact || {};
    return {
      phone: c.sanitized_phone || c.phone_numbers?.[0]?.sanitized_number || c.phone_numbers?.[0]?.raw_number || null,
      email: c.email || c.personal_emails?.[0] || null,
      phone_status: c.phone_numbers?.[0]?.status || null,
      email_status: c.email_status || null,
    };
  } catch (e) {
    console.warn('[apollo] getContactById failed', contactId, apolloErr(e));
    return null;
  }
}

// ----------------------------------------------------------------------------
// Enrichment — find owner contact + Apollo contact id
// ----------------------------------------------------------------------------
export async function findOwner(companyUrl) {
  const domain = domainFromUrl(companyUrl);
  if (!domain) return null;

  try {
    // Apollo deprecated /mixed_people/search for API callers — must use api_search
    // variant. Migration confirmed 2026-05-10 via 422 response on the old path.
    const { data } = await axios.post(
      `${BASE}/mixed_people/api_search`,
      {
        q_organization_domains: domain,
        person_titles: OWNER_TITLES,
        page: 1,
        per_page: 5,
      },
      { headers: headers(), timeout: TIMEOUT }
    );
    const person = (data.people || data.contacts || [])[0];
    if (!person) return null;

    let enriched = person;
    try {
      // Email + phone reveal both require Apollo's "waterfall" enrichment for
      // contacts not in their primary database, which is async via webhook.
      // We pass webhook_url and run_waterfall_email/phone — the synchronous
      // call returns whatever Apollo has cached (may be empty), and the rest
      // arrives at /api/apollo/enrichment-webhook minutes later.
      const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
      const webhookUrl = base ? `${base}/api/apollo/enrichment-webhook` : null;
      const body = {
        first_name: person.first_name,
        last_name: person.last_name,
        domain,
        reveal_personal_emails: true,
      };
      if (webhookUrl) {
        body.webhook_url = webhookUrl;
        body.reveal_phone_number = true;
        body.run_waterfall_email = true;
        body.run_waterfall_phone = true;
      }
      const enrich = await axios.post(`${BASE}/people/match`, body, {
        headers: headers(),
        timeout: TIMEOUT,
      });
      enriched = { ...person, ...(enrich.data?.person || {}) };
    } catch (e) {
      console.warn('[apollo] /people/match fallback', domain, apolloErr(e));
    }

    // Parent / acquisition signal — Apollo's organization object exposes the
    // parent account when one exists. We surface both id and name so the
    // pipeline can flag rolled-up companies (Phase 5).
    const org = enriched.organization || {};
    const parentName =
      org.parent_account_name ||
      org.parent_organization_name ||
      org.owned_by_organization_name ||
      null;
    const parentId =
      org.parent_account_id ||
      org.parent_organization_id ||
      org.owned_by_organization_id ||
      null;

    return {
      apollo_contact_id: enriched.id || person.id || null,
      apollo_organization_id: org.id || enriched.organization_id || null,
      name: enriched.name || `${enriched.first_name || ''} ${enriched.last_name || ''}`.trim(),
      title: enriched.title || null,
      email: enriched.email || enriched.personal_emails?.[0] || null,
      phone:
        enriched.sanitized_phone ||
        enriched.phone_numbers?.[0]?.sanitized_number ||
        enriched.phone_numbers?.[0]?.raw_number ||
        null,
      linkedin_url: enriched.linkedin_url || null,
      parent_company: parentName,
      parent_organization_id: parentId,
    };
  } catch (e) {
    console.warn('[apollo] findOwner failed', domain, apolloErr(e));
    return null;
  }
}

// ----------------------------------------------------------------------------
// Sequence creation — once at launch, locks templates+steps into Apollo
// ----------------------------------------------------------------------------

/**
 * Creates an Apollo emailer_campaign matching our campaign's sequence_config + email_templates.
 * Returns { id, error }.
 *
 * Apollo's emailer_step API accepts wait_mode + wait_amount. We use 'day' units,
 * since our sequence_config stores wait_days. Email steps get a touch with
 * subject + body. Call steps are added as a manual call task (no touch).
 */
export async function createSequenceFromCampaign({ name, sequence_config, email_templates }) {
  // 1. Create the emailer_campaign shell
  let emailerCampaignId;
  try {
    const { data } = await axios.post(
      `${BASE}/emailer_campaigns`,
      { name, permissions: 'team_can_use', active: true },
      { headers: headers(), timeout: TIMEOUT }
    );
    emailerCampaignId = data?.emailer_campaign?.id || data?.id;
    if (!emailerCampaignId) throw new Error('Apollo did not return a sequence id');
  } catch (e) {
    return { id: null, error: `Sequence create failed: ${apolloErr(e)}` };
  }

  // 2. Add steps in order
  const errors = [];
  let emailIdx = 0; // index into email_templates
  for (let i = 0; i < (sequence_config || []).length; i++) {
    const step = sequence_config[i];
    if (!step?.active) continue;
    const isEmail = step.type === 'email';

    let stepResp;
    try {
      // Apollo's emailer_steps API expects `wait_time`, not `wait_amount`.
      // Sending `wait_amount` produces a misleading 422 "Wait time must not be empty"
      // even though the step gets created with a default wait_time. Confirmed
      // via live probe 2026-05-10. Also: Apollo rejects wait_time=0 — minimum is 1.
      const { data } = await axios.post(
        `${BASE}/emailer_steps`,
        {
          emailer_campaign_id: emailerCampaignId,
          position: i + 1,
          type: isEmail ? 'auto_email' : 'call',
          wait_mode: 'day',
          wait_time: Math.max(1, step.wait_days || 1),
        },
        { headers: headers(), timeout: TIMEOUT }
      );
      stepResp = data?.emailer_step || data;
    } catch (e) {
      errors.push(`Step ${i + 1} (${step.type}) create failed: ${apolloErr(e)}`);
      continue;
    }

    // 3. For email steps, attach a touch with the template
    if (isEmail) {
      const tpl = (email_templates || [])[Math.min(emailIdx, (email_templates || []).length - 1)];
      emailIdx++;
      if (!tpl) continue;
      try {
        await axios.post(
          `${BASE}/emailer_touches`,
          {
            emailer_step_id: stepResp?.id,
            subject: tpl.subject || '',
            body_html: tpl.body || '',
            body_text: tpl.body || '',
          },
          { headers: headers(), timeout: TIMEOUT }
        );
      } catch (e) {
        errors.push(`Step ${i + 1} touch (email body) failed: ${apolloErr(e)}`);
      }
    }
  }

  return {
    id: emailerCampaignId,
    error: errors.length ? errors.join(' | ') : null,
  };
}

// ----------------------------------------------------------------------------
// Add a contact to a sequence
// ----------------------------------------------------------------------------
export async function addContactToSequence({ sequenceId, apolloContactId, sendFromAccountId }) {
  if (!sequenceId || !apolloContactId) return { ok: false, error: 'sequenceId and apolloContactId required' };
  try {
    const body = {
      contact_ids: [apolloContactId],
      emailer_campaign_id: sequenceId,
    };
    if (sendFromAccountId) body.send_email_from_email_account_id = sendFromAccountId;
    const { data } = await axios.post(
      `${BASE}/emailer_campaigns/${sequenceId}/add_contact_ids`,
      body,
      { headers: headers(), timeout: TIMEOUT }
    );
    return { ok: true, data };
  } catch (e) {
    const msg = apolloErr(e);
    console.warn('[apollo] addContactToSequence failed', msg);
    return { ok: false, error: msg };
  }
}

// ----------------------------------------------------------------------------
// Two-way sync: log a call to Apollo (advances the contact past a call step)
// ----------------------------------------------------------------------------
const CALL_DISPOSITIONS = {
  connected: 'Connected',
  voicemail: 'Left Voicemail',
  no_answer: 'No Answer',
  busy: 'No Answer',
  completed: 'Connected',
};

export async function logCallToApollo({ apolloContactId, outcome, durationSec = 0, notes = '' }) {
  if (!apolloContactId) return { ok: false, error: 'apolloContactId required' };
  const disposition = CALL_DISPOSITIONS[outcome] || 'No Answer';
  try {
    const { data } = await axios.post(
      `${BASE}/contacts/${apolloContactId}/log_call`,
      {
        disposition,
        duration: durationSec,
        notes: notes || `Auto-logged by targetoutreach: ${outcome}`,
      },
      { headers: headers(), timeout: TIMEOUT }
    );
    return { ok: true, data };
  } catch (e) {
    const msg = apolloErr(e);
    console.warn('[apollo] logCallToApollo failed', msg);
    return { ok: false, error: msg };
  }
}

// ----------------------------------------------------------------------------
// Activate / deactivate — Apollo's "active" toggle (the play/pause primitive
// that the dashboard maps to). Documented endpoints:
//   POST /emailer_campaigns/{id}/approve  -> activate (sequence must have ≥ 1 step)
//   POST /emailer_campaigns/{id}/abort    -> deactivate (pauses all contacts, stops sending)
// ----------------------------------------------------------------------------
export async function setSequenceActive(sequenceId, active) {
  if (!sequenceId) return { ok: false, error: 'sequenceId required' };
  const path = active ? 'approve' : 'abort';
  try {
    const { data } = await axios.post(
      `${BASE}/emailer_campaigns/${sequenceId}/${path}`,
      {},
      { headers: headers(), timeout: TIMEOUT }
    );
    const ec = data?.emailer_campaign || data;
    return { ok: true, active: ec?.active };
  } catch (e) {
    const msg = apolloErr(e);
    console.warn(`[apollo] setSequenceActive(${active}) failed`, msg);
    return { ok: false, error: msg };
  }
}

// Archive — terminal state used when a campaign is deleted from the dashboard.
// Stops processing AND moves the sequence to the archive (out of the active list).
// Endpoint: POST /emailer_campaigns/{id}/archive
export async function archiveSequence(sequenceId) {
  if (!sequenceId) return { ok: false, error: 'sequenceId required' };
  try {
    const { data } = await axios.post(
      `${BASE}/emailer_campaigns/${sequenceId}/archive`,
      {},
      { headers: headers(), timeout: TIMEOUT }
    );
    const ec = data?.emailer_campaign || data;
    return { ok: true, archived: ec?.archived };
  } catch (e) {
    const msg = apolloErr(e);
    console.warn('[apollo] archiveSequence failed', msg);
    return { ok: false, error: msg };
  }
}

// ----------------------------------------------------------------------------
// Organization Search — used as a lead source from the campaign wizard.
// Claude extracts structured filters from the campaign brief; we paginate
// up to maxPages (5 × 100 = 500 organizations) and dedupe by primary_domain.
// ----------------------------------------------------------------------------
export async function orgSearch(filters = {}, { maxPages = 5, perPage = 100 } = {}) {
  const body = {
    page: 1,
    per_page: perPage,
  };
  if (Array.isArray(filters.industries) && filters.industries.length) body.q_organization_keyword_tags = filters.industries;
  if (Array.isArray(filters.keywords) && filters.keywords.length) {
    body.q_organization_keyword_tags = [...(body.q_organization_keyword_tags || []), ...filters.keywords];
  }
  if (filters.employee_range) {
    const min = filters.employee_range.min, max = filters.employee_range.max;
    if (Number.isFinite(min) || Number.isFinite(max)) {
      body.organization_num_employees_ranges = [`${min ?? 1},${max ?? 10000}`];
    }
  }
  if (filters.revenue_range) {
    const min = filters.revenue_range.min_usd, max = filters.revenue_range.max_usd;
    if (Number.isFinite(min) || Number.isFinite(max)) {
      body.revenue_range = { min: min ?? 0, max: max ?? 10_000_000_000 };
    }
  }
  if (Array.isArray(filters.locations) && filters.locations.length) {
    body.organization_locations = filters.locations;
  }
  if (Array.isArray(filters.exclude_keywords) && filters.exclude_keywords.length) {
    body.q_organization_keyword_tags_exclude = filters.exclude_keywords;
  }

  const out = [];
  const seen = new Set();
  for (let page = 1; page <= maxPages; page++) {
    try {
      const { data } = await axios.post(
        `${BASE}/mixed_companies/search`,
        { ...body, page },
        { headers: headers(), timeout: TIMEOUT }
      );
      const orgs = data?.organizations || data?.accounts || [];
      if (!orgs.length) break;
      for (const o of orgs) {
        const domain = o.primary_domain || domainFromUrl(o.website_url) || null;
        const key = domain || `name:${(o.name || '').toLowerCase().trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(o);
      }
      const pagination = data?.pagination;
      if (pagination && pagination.total_pages && page >= pagination.total_pages) break;
    } catch (e) {
      console.warn('[apollo] orgSearch page', page, 'failed', apolloErr(e));
      break;
    }
  }
  return out;
}

// List the authenticated user's saved labels (lists) — both contact and
// organization scoped. The wizard's "Import Apollo List" dropdown shows these.
export async function listSavedLabels() {
  try {
    const { data } = await axios.get(`${BASE}/labels`, { headers: headers(), timeout: TIMEOUT });
    const labels = data?.labels || data || [];
    return labels.map((l) => ({
      id: l.id,
      name: l.name,
      type: l.label_type || l.modality || 'unknown',
      cached_count: l.cached_count ?? null,
    }));
  } catch (e) {
    console.warn('[apollo] listSavedLabels failed', apolloErr(e));
    return [];
  }
}

// Pull all organizations attached to a saved label. Apollo's filter parameter
// name varies by endpoint + plan tier:
//   /mixed_companies/search  uses  q_organization_label_names  (paid)
//   /accounts/search         uses  account_label_ids           (paid)
//   /mixed_companies/search  uses  label_ids                   (some plans, people-style)
// We try each in turn and log the response shape until one returns rows.
export async function getLabelCompanies(labelId, { maxPages = 10, perPage = 100, labelName } = {}) {
  if (!labelId) return [];

  const variants = [
    { path: '/accounts/search',         body: { account_label_ids: [labelId] }, key: 'account_label_ids on /accounts/search' },
    { path: '/mixed_companies/search',  body: { label_ids: [labelId] },         key: 'label_ids on /mixed_companies/search' },
    { path: '/mixed_companies/search',  body: { account_label_ids: [labelId] }, key: 'account_label_ids on /mixed_companies/search' },
  ];
  if (labelName) {
    variants.push({ path: '/mixed_companies/search', body: { q_organization_label_names: [labelName] }, key: 'q_organization_label_names on /mixed_companies/search' });
  }

  for (const variant of variants) {
    const out = [];
    const seen = new Set();
    let firstPageReturnedRows = false;
    let lastErr = null;
    for (let page = 1; page <= maxPages; page++) {
      try {
        const { data } = await axios.post(
          `${BASE}${variant.path}`,
          { ...variant.body, page, per_page: perPage },
          { headers: headers(), timeout: TIMEOUT }
        );
        const orgs = data?.organizations || data?.accounts || [];
        if (page === 1) {
          console.log(`[apollo] getLabelCompanies tried ${variant.key}: page 1 → ${orgs.length} orgs (pagination: ${JSON.stringify(data?.pagination || {})})`);
          if (!orgs.length) break;
          firstPageReturnedRows = true;
        }
        if (!orgs.length) break;
        for (const o of orgs) {
          const domain = o.primary_domain || domainFromUrl(o.website_url) || null;
          const key = domain || `name:${(o.name || '').toLowerCase().trim()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(o);
        }
        const pagination = data?.pagination;
        if (pagination && pagination.total_pages && page >= pagination.total_pages) break;
      } catch (e) {
        lastErr = apolloErr(e);
        console.warn(`[apollo] getLabelCompanies ${variant.key} page ${page} failed:`, lastErr);
        break;
      }
    }
    if (firstPageReturnedRows && out.length) {
      console.log(`[apollo] getLabelCompanies SUCCESS via ${variant.key}: ${out.length} total orgs`);
      return out;
    }
  }
  console.warn('[apollo] getLabelCompanies: all variants returned 0 rows for label', labelId, labelName || '(no name)');
  return [];
}

// Single-domain organization enrichment — backfills firmographics for leads
// from Exa or CSV that lack industry/employees/revenue/location.
export async function orgEnrich({ domain }) {
  if (!domain) return null;
  try {
    const { data } = await axios.post(
      `${BASE}/organizations/enrich`,
      { domain },
      { headers: headers(), timeout: TIMEOUT }
    );
    return data?.organization || null;
  } catch (e) {
    console.warn('[apollo] orgEnrich failed', domain, apolloErr(e));
    return null;
  }
}

// Normalize an Apollo organization object into the canonical lead-row shape
// used by the pipeline. Matches the column names in the `leads` table.
export function mapApolloOrgToLead(org) {
  if (!org) return null;
  const domain = org.primary_domain || domainFromUrl(org.website_url) || null;
  const city = org.city || org.organization_city || null;
  const state = org.state || org.organization_state || null;
  const location = [city, state].filter(Boolean).join(', ') || org.country || null;
  const revenueNum = org.annual_revenue || org.organization_revenue || null;
  const revenuePrinted = org.annual_revenue_printed
    || (typeof org.organization_revenue === 'string' ? org.organization_revenue : null)
    || (Number.isFinite(revenueNum) ? formatRevenue(revenueNum) : null);
  const parentName = org.parent_account_name || org.owned_by_organization_name || null;

  const fundingEvents = Array.isArray(org.funding_events) ? org.funding_events : null;
  const latestFunding = fundingEvents?.length
    ? fundingEvents
        .map((f) => f?.date)
        .filter(Boolean)
        .sort()
        .at(-1) || null
    : (org.latest_funding_round_date || null);

  return {
    company_name: org.name || null,
    company_url: domain ? `https://${domain}` : (org.website_url || null),
    domain,
    industry: org.industry || (Array.isArray(org.industries) ? org.industries[0] : null) || null,
    employees: org.estimated_num_employees || org.organization_num_employees || null,
    revenue: revenuePrinted,
    location,
    parent_company: parentName,
    ownership: parentName ? 'subsidiary' : 'unknown',
    apollo_organization_id: org.id || null,
    // Extended firmographics — surfaced in the dashboard profile + fed to the
    // cheap Haiku scorer.
    keywords: Array.isArray(org.keywords) ? org.keywords : null,
    technologies: Array.isArray(org.current_technologies)
      ? org.current_technologies
      : (Array.isArray(org.technology_names) ? org.technology_names : null),
    founded_year: Number.isFinite(org.founded_year) ? org.founded_year : null,
    linkedin_url: org.linkedin_url || null,
    twitter_url: org.twitter_url || null,
    facebook_url: org.facebook_url || null,
    naics_codes: Array.isArray(org.naics_codes) ? org.naics_codes : null,
    sic_codes: Array.isArray(org.sic_codes) ? org.sic_codes : null,
    annual_revenue_printed: revenuePrinted,
    estimated_num_employees: org.estimated_num_employees || null,
    funding_events: fundingEvents,
    total_funding: Number.isFinite(org.total_funding) ? org.total_funding : null,
    latest_funding_round_date: latestFunding,
    short_description: org.short_description || org.seo_description || null,
  };
}

function formatRevenue(n) {
  if (!Number.isFinite(n)) return null;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}

// ----------------------------------------------------------------------------
// Polling: pull progress for contacts in a sequence (used by cron to mirror)
// ----------------------------------------------------------------------------
export async function getSequenceContactProgress(sequenceId) {
  if (!sequenceId) return { ok: false, error: 'sequenceId required', rows: [] };
  try {
    // Apollo's exact endpoint for per-contact progress varies by plan.
    // We try the documented one and gracefully degrade if unavailable.
    const { data } = await axios.get(
      `${BASE}/emailer_campaigns/${sequenceId}`,
      { headers: headers(), timeout: TIMEOUT, params: { include_contact_progresses: true } }
    );
    const rows = data?.emailer_campaign?.contact_progresses
      || data?.contact_progresses
      || [];
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: apolloErr(e), rows: [] };
  }
}
