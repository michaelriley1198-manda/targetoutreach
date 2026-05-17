import { supabase } from '../db.js';
import {
  generateSearchQueries,
  enrichLeadProfile,
  scoreLeadFromFirmographics,
  webSearchFirmographics,
} from '../services/claude.js';
import { exaSearchAll } from '../services/exa.js';
import {
  orgSearch,
  getLabelCompanies,
  orgEnrich,
  mapApolloOrgToLead,
  getContactById,
} from '../services/apollo.js';
import { mapRowsToLeads } from '../services/csv.js';
import { discoverOwners } from '../services/owners.js';
import { findCompany as leadMagicFindCompany, fallbackContact as leadMagicFallback } from '../services/leadmagic.js';
import { requestContacts as shRequestContacts } from '../services/signalhire.js';
import { deduplicateCampaign } from './dedup.js';
import { setProgress, clearProgress } from './progress.js';

const ENRICH_CONCURRENCY = 4;
const SCORE_CONCURRENCY = 6;
const OWNER_CONCURRENCY = 4;
const REVEAL_CONCURRENCY = 6;

const QUERIES_PER_BATCH = 25;
const RESULTS_PER_QUERY = 25;

// Score above which we pay for the holistic Claude profile + owner discovery.
// Overridden per-campaign by min_priority_score if that is lower.
const HOLISTIC_SCORE_THRESHOLD = 50;

async function runPool(items, concurrency, worker, onItemDone) {
  const results = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        results[idx] = await worker(items[idx], idx);
        onItemDone?.({ ok: true, idx, result: results[idx] });
      } catch (e) {
        results[idx] = { __error: e.message };
        onItemDone?.({ ok: false, idx, error: e.message });
      }
    }
  });
  await Promise.all(runners);
  return results;
}

function domainOf(url) {
  if (!url) return null;
  const withProto = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try { return new URL(withProto).hostname.replace(/^www\./, ''); } catch { return null; }
}

function slugifyName(name) {
  return String(name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function dedupKey(row) {
  return row.domain || (row.company_name ? `name:${slugifyName(row.company_name)}` : null);
}

function splitFullName(name) {
  if (!name) return { first: null, last: null };
  const parts = String(name).trim().split(/\s+/);
  return { first: parts[0] || null, last: parts.length > 1 ? parts.slice(1).join(' ') : null };
}

export async function generatePromptsForCampaign(campaignId) {
  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .single();
  if (error) throw error;
  return await generateSearchQueries(campaign.prompt);
}

// ----------------------------------------------------------------------------
// Producers — each returns thin rows: { company_name, company_url, domain,
// lead_source, external_ref, _producer_payload }. No Claude calls here; the
// firmographics + scoring stages run uniformly after the merge.
// ----------------------------------------------------------------------------

async function runExaProducer({ campaign, providedQueries, target, maxBatches, capByTarget, onProgress, errors }) {
  const queriesUsed = [];
  const seenDomains = new Set();
  const accepted = [];
  let batch = 0;

  while (batch < maxBatches && (!capByTarget || accepted.length < target)) {
    batch++;
    onProgress?.({ stage: 'producers', message: `Exa batch ${batch}/${maxBatches} — generating queries`, batch, maxBatches });

    let queries;
    if (batch === 1 && providedQueries?.length) {
      queries = providedQueries;
    } else {
      try {
        queries = await generateSearchQueries(campaign.prompt, {
          numQueries: QUERIES_PER_BATCH,
          excludeQueries: queriesUsed,
        });
      } catch (e) {
        errors.push(`Exa batch ${batch}: query generation failed (${e.message}). Stopping Exa source.`);
        break;
      }
    }
    queriesUsed.push(...queries);

    onProgress?.({ stage: 'producers', message: `Exa batch ${batch}/${maxBatches} — ${queries.length} Exa searches`, current: 0, total: queries.length });
    const exaResults = await exaSearchAll(
      queries,
      ({ done, total, errorCount }) => onProgress?.({ current: done, total, searchErrors: errorCount }),
      { numResults: RESULTS_PER_QUERY }
    );

    for (const r of exaResults) {
      const d = r.domain || domainOf(r.url);
      if (!d || seenDomains.has(d)) continue;
      seenDomains.add(d);
      accepted.push({
        lead_source: 'exa',
        company_name: r.title || null,
        company_url: r.url || null,
        domain: d,
        external_ref: { exa_url: r.url },
        _producer_payload: { exa_result: r },
      });
      if (capByTarget && accepted.length >= target) break;
    }

    if (capByTarget && accepted.length >= target) break;
  }

  return accepted;
}

function fromApolloOrg(org, source) {
  const m = mapApolloOrgToLead(org);
  if (!m) return null;
  return {
    lead_source: source,
    firmographics_source: 'apollo_native',
    ...m, // company_name, company_url, domain, industry, employees, revenue,
          // location, parent_company, ownership + all extended fields
    external_ref: { apollo_org_id: m.apollo_organization_id },
    _producer_payload: { apollo_org: org },
  };
}

async function runApolloSearchProducer({ filters, onProgress }) {
  onProgress?.({ stage: 'producers', message: 'Apollo Organization Search — paginating up to 500' });
  const orgs = await orgSearch(filters, { maxPages: 5, perPage: 100 });
  onProgress?.({ message: `Apollo Search returned ${orgs.length} organizations` });
  return orgs.map((o) => fromApolloOrg(o, 'apollo_search')).filter(Boolean);
}

async function runApolloListProducer({ listId, listName, onProgress }) {
  onProgress?.({ stage: 'producers', message: `Apollo Saved List ${listName || listId} — pulling companies` });
  const orgs = await getLabelCompanies(listId, { labelName: listName });
  onProgress?.({ message: `Apollo List returned ${orgs.length} organizations` });
  return orgs.map((o) => fromApolloOrg(o, 'apollo_list')).filter(Boolean);
}

async function runCsvProducer({ stagingId, onProgress }) {
  if (!stagingId) return [];
  const { data: staged, error } = await supabase
    .from('csv_uploads')
    .select('rows, headers')
    .eq('id', stagingId)
    .single();
  if (error || !staged) return [];
  onProgress?.({ stage: 'producers', message: `CSV: parsing ${staged.rows.length} rows` });
  const mapped = mapRowsToLeads(staged.rows, staged.headers);
  return mapped.map((r) => ({
    lead_source: 'csv',
    firmographics_source: 'csv',
    company_name: r.company_name,
    company_url: r.company_url,
    domain: r.domain,
    industry: r.industry,
    employees: r.employees,
    revenue: r.revenue,
    location: r.location,
    external_ref: { csv_row_idx: r._csvRowIdx },
    _producer_payload: { csv_contacts: r.contacts || [] },
  }));
}

// Merge precedence: Apollo Search > Apollo List > CSV > Exa.
const SOURCE_PRIORITY = { apollo_search: 4, apollo_list: 3, csv: 2, exa: 1 };

function mergeRow(target, src) {
  for (const k of Object.keys(src)) {
    if (k === '_producer_payload') {
      target._producer_payload = { ...(target._producer_payload || {}), ...(src._producer_payload || {}) };
      continue;
    }
    if (k === 'external_ref') {
      target.external_ref = { ...(target.external_ref || {}), ...(src.external_ref || {}) };
      continue;
    }
    if (src[k] != null && src[k] !== '') {
      if (target[k] == null || target[k] === '' || SOURCE_PRIORITY[src.lead_source] > SOURCE_PRIORITY[target.lead_source]) {
        target[k] = src[k];
      }
    }
  }
}

function mergeProducers(producerResults) {
  const map = new Map();
  const all = [];
  for (const rows of producerResults) all.push(...rows);
  all.sort((a, b) => (SOURCE_PRIORITY[a.lead_source] || 0) - (SOURCE_PRIORITY[b.lead_source] || 0));

  for (const row of all) {
    const key = dedupKey(row);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, { ...row });
    } else {
      const existing = map.get(key);
      mergeRow(existing, row);
      if ((SOURCE_PRIORITY[row.lead_source] || 0) > (SOURCE_PRIORITY[existing.lead_source] || 0)) {
        existing.lead_source = row.lead_source;
        existing.firmographics_source = row.firmographics_source;
      }
    }
  }
  return Array.from(map.values());
}

// ----------------------------------------------------------------------------
// Stage 2 — Apollo firmographics enrichment, with LeadMagic + Claude
// web-search fallback when Apollo misses. Mutates the in-memory row.
// ----------------------------------------------------------------------------
function applyFirmographics(row, source, m) {
  if (!m) return;
  for (const k of Object.keys(m)) {
    if (m[k] != null && m[k] !== '' && (row[k] == null || row[k] === '')) {
      row[k] = m[k];
    }
  }
  row.firmographics_source = source;
}

async function enrichFirmographicsOne(row) {
  // Apollo-native rows (apollo_search / apollo_list) already carry the full
  // org payload — skip the network round-trip.
  if (row.firmographics_source === 'apollo_native') return;
  if (!row.domain && !row.company_url) return;
  const domain = row.domain || domainOf(row.company_url);
  if (!domain) return;

  const org = await orgEnrich({ domain }).catch(() => null);
  if (org) {
    applyFirmographics(row, 'apollo_org_enrich', mapApolloOrgToLead(org));
    return;
  }
  // LeadMagic fallback
  const lm = await leadMagicFindCompany({ domain }).catch(() => null);
  if (lm) {
    applyFirmographics(row, 'leadmagic', lm);
    return;
  }
  // Claude web-search fallback
  const ws = await webSearchFirmographics({
    companyName: row.company_name,
    companyUrl: row.company_url,
    domain,
  }).catch(() => null);
  if (ws) {
    applyFirmographics(row, 'claude_web_search', ws);
  }
}


// ----------------------------------------------------------------------------
// Main pipeline
// ----------------------------------------------------------------------------
export async function launchCampaign(campaignId, providedQueries = null, opts = {}) {
  const { skipEnrichment = false, csvStagingId = null } = opts;
  const errors = [];
  setProgress(campaignId, {
    stage: 'producers',
    message: 'Initializing',
    current: 0,
    total: 1,
    leadsFound: 0,
    errors,
    finishedAt: null,
  });

  try {
    const { data: campaign, error } = await supabase
      .from('campaigns')
      .select('*')
      .eq('id', campaignId)
      .single();
    if (error) throw new Error(`Load campaign failed: ${error.message}`);

    const target = campaign.target_lead_count || 150;
    const minScore = campaign.min_priority_score ?? 50;
    const maxBatches = campaign.max_search_batches || 4;
    const sources = Array.isArray(campaign.lead_sources) && campaign.lead_sources.length
      ? campaign.lead_sources
      : ['exa'];

    const hasImport = sources.includes('apollo_list') || sources.includes('csv');
    const capExa = !hasImport;

    const onProgress = (patch) => setProgress(campaignId, patch);

    // ----- Stage 1: producers --------------------------------------------------
    const producers = [];
    if (sources.includes('exa')) {
      producers.push(runExaProducer({
        campaign, providedQueries, target, maxBatches,
        capByTarget: capExa, onProgress, errors,
      }));
    }
    if (sources.includes('apollo_search') && campaign.apollo_filter_json) {
      producers.push(runApolloSearchProducer({ filters: campaign.apollo_filter_json, onProgress }));
    }
    if (sources.includes('apollo_list') && campaign.apollo_list_id) {
      producers.push(runApolloListProducer({ listId: campaign.apollo_list_id, listName: campaign.apollo_list_name, onProgress }));
    }
    if (sources.includes('csv') && csvStagingId) {
      producers.push(runCsvProducer({ stagingId: csvStagingId, onProgress }));
    }
    if (!producers.length) {
      throw new Error('No active lead sources for this campaign (lead_sources empty or missing source configs).');
    }

    const producerResults = await Promise.all(producers);
    const merged = mergeProducers(producerResults);
    onProgress({ stage: 'merge', message: `Merged ${merged.length} unique companies across ${producers.length} source(s)` });
    if (!merged.length) throw new Error('No leads produced by any source.');

    // ----- Stage 2: Apollo firmographics (with LM + Claude fallback) -----------
    onProgress({
      stage: 'apollo_enrich',
      message: `Enriching firmographics for ${merged.length} companies`,
      current: 0, total: merged.length,
    });
    let firmOk = 0, firmFail = 0;
    await runPool(
      merged,
      ENRICH_CONCURRENCY,
      async (row) => { await enrichFirmographicsOne(row); return row; },
      ({ ok }) => {
        if (ok) firmOk++; else firmFail++;
        onProgress({ current: firmOk + firmFail });
      }
    );

    // ----- Stage 3: cheap Haiku scoring on firmographics ----------------------
    onProgress({
      stage: 'score',
      message: `Scoring ${merged.length} companies`,
      current: 0, total: merged.length,
    });
    let scoreOk = 0, scoreFail = 0;
    await runPool(
      merged,
      SCORE_CONCURRENCY,
      async (row) => {
        const r = await scoreLeadFromFirmographics({
          campaignPrompt: campaign.prompt,
          firmographics: row,
        });
        if (r) {
          row.pass_fail = r.pass_fail;
          row.priority_score = r.priority_score;
          row.fit_score = r.fit_score;
          row.ownership = r.ownership || row.ownership || 'unknown';
          row._score_reason = r.reason;
        } else {
          // If Claude returned no JSON, treat as low-priority FAIL so we don't
          // spend on holistic later, but still surface in the list.
          row.pass_fail = 'FAIL';
          row.priority_score = 0;
          row.fit_score = 3;
        }
      },
      ({ ok }) => {
        if (ok) scoreOk++; else scoreFail++;
        onProgress({ current: scoreOk + scoreFail });
      }
    );

    // ----- Stage 4: acquired / excluded-acquirer FAIL gate --------------------
    const excluded = (campaign.excluded_acquirers || []).map((s) => String(s || '').toLowerCase()).filter(Boolean);
    const requireIndependent = campaign.require_independent !== false;
    let acquiredFailed = 0;
    for (const row of merged) {
      if (!row.parent_company) continue;
      const pc = String(row.parent_company).toLowerCase();
      const exclMatch = excluded.find((e) => pc.includes(e));
      const failBecause = exclMatch
        ? `Rolled up by ${row.parent_company} (matches excluded acquirers list)`
        : (requireIndependent ? `Rolled up by ${row.parent_company} (require_independent on)` : null);
      if (failBecause) {
        row.pass_fail = 'FAIL';
        row.flags = failBecause;
        acquiredFailed++;
      }
    }
    if (acquiredFailed) errors.push(`${acquiredFailed} company(ies) FAIL'd as rolled-up acquisitions.`);

    // ----- Stage 4b: insert leads --------------------------------------------
    const insertRows = merged.map((r) => ({
      campaign_id: campaignId,
      company_name: r.company_name,
      company_url: r.company_url,
      fit_score: r.fit_score ?? null,
      priority_score: r.priority_score ?? 0,
      pass_fail: r.pass_fail || 'PASS',
      industry: r.industry || null,
      revenue: r.revenue || null,
      employees: r.employees ?? null,
      location: r.location || null,
      ownership: r.ownership || null,
      parent_company: r.parent_company || null,
      acquired_flag: !!r.parent_company,
      flags: r.flags || null,
      lead_source: r.lead_source,
      firmographics_source: r.firmographics_source,
      external_ref: r.external_ref || null,
      status: 'new',
      sequence_step: 0,
      // Extended firmographics
      keywords: r.keywords || null,
      technologies: r.technologies || null,
      founded_year: r.founded_year ?? null,
      linkedin_url: r.linkedin_url || null,
      twitter_url: r.twitter_url || null,
      facebook_url: r.facebook_url || null,
      naics_codes: r.naics_codes || null,
      sic_codes: r.sic_codes || null,
      annual_revenue_printed: r.annual_revenue_printed || null,
      estimated_num_employees: r.estimated_num_employees ?? null,
      funding_events: r.funding_events || null,
      total_funding: Number.isFinite(r.total_funding) ? r.total_funding : null,
      latest_funding_round_date: r.latest_funding_round_date || null,
      short_description: r.short_description || null,
    }));

    const { data: inserted, error: insertErr } = await supabase.from('leads').insert(insertRows).select();
    if (insertErr) throw new Error(`DB insert failed: ${insertErr.message}`);

    // Map merged → inserted lead id (1:1 in insert order — Supabase preserves
    // order on insert).
    for (let i = 0; i < merged.length; i++) merged[i]._lead_id = inserted[i].id;

    const pass = merged.filter((r) => r.pass_fail === 'PASS');
    onProgress({
      message: `Inserted ${inserted.length} leads — ${pass.length} PASS, ${inserted.length - pass.length} FAIL`,
      leadsFound: pass.length,
    });

    if (skipEnrichment) {
      errors.push('skip_enrichment: skipped holistic Claude profile, owner discovery, and Apollo sequence.');
      await supabase.from('campaigns').update({ status: 'running' }).eq('id', campaignId);
      onProgress({
        stage: 'done',
        message: `Done — ${pass.length} PASS leads (enrichment skipped)`,
        leadsFound: pass.length,
        finishedAt: Date.now(),
      });
      return { inserted: pass.length };
    }

    // ----- Stage 5: holistic Claude profile (score ≥ campaign threshold) ------
    const holisticThreshold = Math.min(minScore, HOLISTIC_SCORE_THRESHOLD);
    const highPri = pass.filter((r) => (r.priority_score ?? 0) >= holisticThreshold);
    onProgress({
      stage: 'holistic',
      message: `Holistic profile for ${highPri.length} high-priority leads`,
      current: 0, total: highPri.length,
    });
    let holOk = 0, holFail = 0;
    await runPool(
      highPri,
      ENRICH_CONCURRENCY,
      async (row) => {
        const exa = row._producer_payload?.exa_result || null;
        const profile = await enrichLeadProfile({
          campaignPrompt: campaign.prompt,
          exaResult: exa,
          firmographics: row,
        }).catch(() => null);
        if (!profile) return null;
        // persist
        const update = {
          description: profile.description || null,
          fit_rationale: profile.fit_rationale || null,
          vertical_signal: profile.vertical_signal || null,
          flags: row.flags || profile.flags || null,
          revenue: row.revenue || profile.revenue || null,
          ebitda: profile.ebitda || null,
          employees: row.employees ?? profile.employees ?? null,
          bio_json: profile.bio_json || null,
        };
        row.description = update.description;
        row.fit_rationale = update.fit_rationale;
        row.bio_json = update.bio_json;
        await supabase.from('leads').update(update).eq('id', row._lead_id);
        return profile;
      },
      ({ ok }) => {
        if (ok) holOk++; else holFail++;
        onProgress({ current: holOk + holFail });
      }
    );

    // ----- Stage 5b: dedup leads by domain, owners by email -------------------
    await deduplicateCampaign(campaignId);

    // ----- Stage 6: owner discovery (PASS + score > 50) ----------------------
    onProgress({
      stage: 'owners',
      message: `Discovering owners at ${highPri.length} companies`,
      current: 0, total: highPri.length,
    });
    const allOwnerRows = []; // { lead_id, ...owner fields } for downstream stages

    let ownerOk = 0, ownerFail = 0;
    await runPool(
      highPri,
      OWNER_CONCURRENCY,
      async (row) => {
        const domain = row.domain || domainOf(row.company_url);
        const csvContacts = row._producer_payload?.csv_contacts || [];

        let discovered;
        if (row.lead_source === 'csv' && csvContacts.length && csvContacts[0]?.name) {
          // CSV brought its own contacts — skip the discovery cost.
          discovered = csvContacts.map((c) => {
            const { first, last } = splitFullName(c.name);
            return {
              name: c.name,
              first_name: c.first_name || first,
              last_name: c.last_name || last,
              title: c.title || null,
              email: c.email || null,
              phone: c.phone || null,
              linkedin_url: c.linkedin_url || null,
              apollo_contact_id: c.apollo_contact_id || null,
              source: 'csv',
              confidence: c.apollo_contact_id ? 'high' : 'medium',
            };
          });
        } else {
          discovered = await discoverOwners({
            companyName: row.company_name,
            companyUrl: row.company_url,
            domain,
          }).catch(() => []);
        }

        if (!discovered?.length) return [];

        const ownerInserts = discovered.map((o) => ({
          lead_id: row._lead_id,
          name: o.name || null,
          first_name: o.first_name || null,
          last_name: o.last_name || null,
          title: o.title || null,
          email: o.email || null,
          phone: o.phone || null,
          linkedin_url: o.linkedin_url || null,
          sources: o.source ? [o.source] : [],
          confidence: o.confidence || null,
          apollo_contact_id: o.apollo_contact_id || null,
          enrichment_source: o.apollo_contact_id ? 'apollo' : null,
        }));
        const { data: ownerRows, error: ownerErr } = await supabase
          .from('lead_owners')
          .insert(ownerInserts)
          .select();
        if (ownerErr) {
          console.warn('[pipeline] insert lead_owners failed', row.company_name, ownerErr.message);
          return [];
        }
        for (const o of ownerRows) o._domain = domain;
        allOwnerRows.push(...ownerRows);
        return ownerRows;
      },
      ({ ok }) => {
        if (ok) ownerOk++; else ownerFail++;
        onProgress({ current: ownerOk + ownerFail });
      }
    );

    // ----- Stage 7a: Apollo cached email for known contact IDs (free) ---------
    const apolloCacheTargets = allOwnerRows.filter((o) => o.apollo_contact_id && !o.email);
    if (apolloCacheTargets.length) {
      await runPool(apolloCacheTargets, REVEAL_CONCURRENCY, async (owner) => {
        const r = await getContactById(owner.apollo_contact_id).catch(() => null);
        const email = r?.email || null;
        if (email) {
          await supabase.from('lead_owners').update({ email, email_status: 'apollo_cached' }).eq('id', owner.id);
          owner.email = email;
        }
        return r;
      }, () => {});
    }

    // ----- Stage 7: LeadMagic contact enrichment (phone + email fallback) ----
    const lmTargets = allOwnerRows.filter((o) => o.first_name && o.last_name && o._domain && (!o.email || !o.phone));
    if (process.env.LEADMAGIC_API_KEY && lmTargets.length) {
      onProgress({
        stage: 'leadmagic',
        message: `LeadMagic enrichment for ${lmTargets.length} owners`,
        current: 0, total: lmTargets.length,
      });
      let lmOk = 0, lmFail = 0;
      await runPool(
        lmTargets,
        REVEAL_CONCURRENCY,
        async (owner) => {
          const update = await leadMagicFallback(owner, { companyDomain: owner._domain }).catch(() => null);
          if (update) {
            await supabase.from('lead_owners').update(update).eq('id', owner.id);
            Object.assign(owner, update);
          }
          return update;
        },
        ({ ok }) => {
          if (ok) lmOk++; else lmFail++;
          onProgress({ current: lmOk + lmFail });
        }
      );
    }

    // ----- Stage 8: Signal Hire async phone enrichment -------------------------
    // Queues owners still missing phone via Signal Hire webhook; results land
    // at /api/signalhire/webhook after processing (seconds to minutes).
    const shBase = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    if (process.env.SIGNALHIRE_API_KEY && shBase) {
      const shTargets = allOwnerRows.filter((o) => !o.phone && (o.linkedin_url || o.email));
      if (shTargets.length) {
        onProgress({ stage: 'signalhire', message: `Signal Hire queued for ${shTargets.length} owners`, current: 0, total: shTargets.length });
        const callbackUrl = `${shBase}/api/signalhire/webhook`;
        for (let j = 0; j < shTargets.length; j += 100) {
          const batch = shTargets.slice(j, j + 100);
          const items = batch.map((o) => o.linkedin_url || o.email);
          await shRequestContacts(items, callbackUrl).catch(() => null);
        }
      }
    }

    // ----- Stage 9: mirror primary owner → leads (legacy compat for dialer) --
    // Primary = first owner with email+phone, falling back to email-only,
    // falling back to first row.
    const ownersByLead = new Map();
    for (const o of allOwnerRows) {
      if (!ownersByLead.has(o.lead_id)) ownersByLead.set(o.lead_id, []);
      ownersByLead.get(o.lead_id).push(o);
    }
    for (const [leadId, owners] of ownersByLead.entries()) {
      const sorted = [...owners].sort((a, b) => {
        const aS = (a.email && a.phone) ? 3 : (a.email ? 2 : (a.phone ? 1 : 0));
        const bS = (b.email && b.phone) ? 3 : (b.email ? 2 : (b.phone ? 1 : 0));
        return bS - aS;
      });
      const primary = sorted[0];
      await supabase.from('leads').update({
        contact_name: primary.name || null,
        contact_title: primary.title || null,
        email: primary.email || null,
        phone: primary.phone || null,
        apollo_contact_id: primary.apollo_contact_id || null,
        enrichment_source: primary.enrichment_source || null,
        email_status: primary.email_status || null,
        phone_status: primary.phone_status || null,
      }).eq('id', leadId);
    }

    // Stage 10 removed — outreach is managed in-tool.

    await supabase.from('campaigns').update({ status: 'running' }).eq('id', campaignId);
    onProgress({
      stage: 'done',
      message: `Done — ${pass.length} PASS leads, ${allOwnerRows.length} owners`,
      leadsFound: pass.length,
      finishedAt: Date.now(),
    });
    return { inserted: pass.length };
  } catch (e) {
    errors.push(e.message);
    setProgress(campaignId, {
      stage: 'error',
      message: `Pipeline failed: ${e.message}`,
      finishedAt: Date.now(),
    });
    console.error(`[launch] campaign ${campaignId} failed`, e);
    throw e;
  } finally {
    setTimeout(() => clearProgress(campaignId), 10 * 60 * 1000);
  }
}
