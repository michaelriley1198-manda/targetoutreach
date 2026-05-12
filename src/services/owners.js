// Multi-owner discovery: cross-references the company website, LinkedIn (via Exa),
// and Apollo to identify every owner-equivalent contact at a company.
//
// Why this exists: Apollo's `title` field is unreliable for picking THE owner.
// It merges multi-location businesses, lists people under stale titles, and
// returns a different "Owner" than the one on the website. The website (and to
// a lesser extent, LinkedIn) is the authoritative source for who actually runs
// the company. We use Apollo only to enrich contact info for people we've
// already named from elsewhere.

import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import { exaSearch } from './exa.js';

const APOLLO_BASE = 'https://api.apollo.io/api/v1';
const TIMEOUT = 30_000;
const HAIKU = 'claude-haiku-4-5-20251001';

const anthropic = new Anthropic({ apiKey: process.env.APP_ANTHROPIC_API_KEY });

const OWNER_ROLES_PROMPT = `owner, co-owner, founder, co-founder, CEO, president, principal, managing partner, managing director, managing member, chief manager, vice president (if no other owner-equivalent listed)`;

const PATHS_TO_TRY = [
  '', '/about', '/about-us', '/team', '/our-team', '/leadership',
  '/our-story', '/company', '/contact',
  // Phase B2 additions — small operators often use these instead.
  '/who-we-are', '/staff', '/people', '/history', '/our-history', '/family',
];

function safeOrigin(companyUrl) {
  try {
    const u = new URL(/^https?:\/\//i.test(companyUrl) ? companyUrl : `https://${companyUrl}`);
    return u.origin;
  } catch { return null; }
}

async function fetchPageText(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 15_000,
      maxContentLength: 2_000_000,
      maxRedirects: 3,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; targetoutreach/1.0)' },
      responseType: 'text',
    });
    return typeof data === 'string' ? data : '';
  } catch {
    return '';
  }
}

function htmlToText(html) {
  if (!html) return '';
  // Strip scripts/styles, then tags. Crude but adequate for the names we want.
  const noScript = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  return noScript.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  try { return JSON.parse(candidate); } catch {}
  const first = candidate.search(/[{[]/);
  const last = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  if (first === -1 || last === -1) return null;
  try { return JSON.parse(candidate.slice(first, last + 1)); } catch { return null; }
}

// ----------------------------------------------------------------------------
// 1. Website scour — try each /about, /team, /leadership path; concat text;
//    Claude extracts names + titles.
// ----------------------------------------------------------------------------
export async function findOwnersFromWebsite(companyUrl) {
  const origin = safeOrigin(companyUrl);
  if (!origin) return [];

  // Fetch in parallel; ignore failures.
  const pages = await Promise.all(PATHS_TO_TRY.map(async (path) => {
    const html = await fetchPageText(origin + path);
    if (!html) return null;
    const text = htmlToText(html).slice(0, 8000); // per-page cap
    if (text.length < 60) return null;
    return { path, text };
  }));

  const corpus = pages.filter(Boolean).map((p) => `=== ${p.path || '/'} ===\n${p.text}`).join('\n\n').slice(0, 24000);
  if (!corpus) return [];

  const system = `You extract owner-equivalent leadership contacts from a company website's text. Return STRICT JSON — no prose, no fences — of the form {"owners":[{"name":"Full Name","title":"...","email":"foo@bar.com or null","phone":"+1... or null"}, ...]}.

Owner-equivalent roles: ${OWNER_ROLES_PROMPT}.

Rules:
- Only include people whose role on the page maps to an owner-equivalent role.
- Use the FULL name as it appears on the page (first + last). If only first name appears, use first name.
- Use the title as it appears on the page (e.g., "Chief Manager", "Founder & CEO").
- Include email/phone ONLY if the page explicitly lists them. Never invent.
- If no owner-equivalents found, return {"owners":[]}.`;

  const user = `Company URL: ${companyUrl}\n\nWEBSITE TEXT:\n${corpus}\n\nReturn the JSON now.`;

  try {
    const res = await anthropic.messages.create({
      model: HAIKU,
      max_tokens: 800,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    const json = extractJson(text);
    return (json?.owners || []).map((o) => ({ ...o, source: 'website' }));
  } catch (e) {
    console.warn('[owners/website] extraction failed', companyUrl, e.message);
    return [];
  }
}

// ----------------------------------------------------------------------------
// 2. LinkedIn discovery via Exa — search for "<company>" + owner-keywords,
//    keep results from linkedin.com/in/, parse names from titles/snippets.
// ----------------------------------------------------------------------------
export async function findOwnersFromLinkedIn(companyName, domain) {
  if (!companyName) return [];
  const queries = [
    `${companyName} owner OR founder OR CEO OR president linkedin`,
    `site:linkedin.com/in ${companyName}`,
  ];

  const results = [];
  for (const q of queries) {
    try {
      const r = await exaSearch(q, { numResults: 8, type: 'keyword' });
      results.push(...r);
    } catch (e) {
      console.warn('[owners/linkedin] exa failed', q, e.message);
    }
  }

  const liResults = results.filter((r) => /linkedin\.com\/in\//i.test(r.url));
  if (!liResults.length) return [];

  const text = liResults.map((r) =>
    `URL: ${r.url}\nTitle: ${r.title || ''}\nSnippet: ${(r.text || '').slice(0, 400)}`
  ).join('\n\n---\n\n').slice(0, 12000);

  const system = `You parse LinkedIn search results and extract people who are owner-equivalent at a specific company. Return STRICT JSON — no prose, no fences — of the form {"owners":[{"name":"Full Name","title":"...","linkedin_url":"https://linkedin.com/in/..."}, ...]}.

Owner-equivalent roles: ${OWNER_ROLES_PROMPT}.

Rules:
- Only include results where the LinkedIn title clearly indicates an owner-equivalent role at the target company (matched by name or domain).
- "Salesperson at X" or "Sales / PM at X" do NOT qualify.
- If unsure, exclude.
- Return empty owners array if no qualifying matches.`;

  const user = `Target company: ${companyName} (domain: ${domain || 'unknown'})\n\nLINKEDIN SEARCH RESULTS:\n${text}\n\nReturn JSON now.`;

  try {
    const res = await anthropic.messages.create({
      model: HAIKU,
      max_tokens: 800,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const t = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    const json = extractJson(t);
    return (json?.owners || []).map((o) => ({ ...o, source: 'linkedin' }));
  } catch (e) {
    console.warn('[owners/linkedin] extraction failed', companyName, e.message);
    return [];
  }
}

// ----------------------------------------------------------------------------
// 3. Broad Exa search — used as a fallback when website + LinkedIn yield zero.
//    Casts a wider net across BBB, Manta, news, business directories, blogs.
// ----------------------------------------------------------------------------
export async function findOwnersFromBroadSearch(companyName, domain) {
  if (!companyName) return [];

  const queries = [
    `"${companyName}" owner OR president OR CEO OR founder OR principal`,
    `"${companyName}" "owned by" OR "founded by"`,
    `"${companyName}" officers OR principals OR partners`,
    `"${companyName}" Inc bio biography history`,
  ];

  const allResults = [];
  for (const q of queries) {
    try {
      const r = await exaSearch(q, { numResults: 8, type: 'neural' });
      allResults.push(...r);
    } catch (e) {
      console.warn('[owners/broad] exa failed', q, e.message);
    }
  }

  // Dedupe by URL; drop LinkedIn (already covered by findOwnersFromLinkedIn).
  const seen = new Set();
  const dedup = [];
  for (const r of allResults) {
    if (!r?.url || seen.has(r.url)) continue;
    if (/linkedin\.com/i.test(r.url)) continue;
    seen.add(r.url);
    dedup.push(r);
  }
  if (!dedup.length) return [];

  const text = dedup.slice(0, 16).map((r) =>
    `URL: ${r.url}\nTitle: ${r.title || ''}\nText: ${(r.text || '').slice(0, 800)}\nHighlights: ${(r.highlights || []).join(' | ')}`
  ).join('\n\n---\n\n').slice(0, 14000);

  const system = `You parse mixed search results (BBB, Manta, news articles, business directories, blogs, association pages, etc.) to extract owner-equivalent contacts at a specific company. Return STRICT JSON — no prose, no fences — of the form {"owners":[{"name":"Full Name","title":"...","email":"or null","phone":"or null"}, ...]}.

Owner-equivalent roles: ${OWNER_ROLES_PROMPT}.

Rules:
- Only include people clearly identified as owner-equivalent at the TARGET company (matched by name or domain).
- Use FULL name as it appears (first + last). If only first name appears, still include but use just the first name.
- Use the title as it appears in the source.
- Include email/phone ONLY if the source explicitly lists them. Never invent.
- Skip results about other companies with similar names.
- Return empty owners array if nothing qualifies.`;

  const user = `Target: ${companyName} (domain: ${domain || 'unknown'})\n\nSEARCH RESULTS:\n${text}\n\nReturn JSON now.`;

  try {
    const res = await anthropic.messages.create({
      model: HAIKU,
      max_tokens: 800,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const t = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    const json = extractJson(t);
    return (json?.owners || []).map((o) => ({ ...o, source: 'broad-search' }));
  } catch (e) {
    console.warn('[owners/broad] extraction failed', companyName, e.message);
    return [];
  }
}

// ----------------------------------------------------------------------------
// 4. Apollo enrichment by name — drops the title filter we used to (mis)trust.
//    Inputs come from the website/LinkedIn ground truth; Apollo just fills in
//    email + phone + canonical id + linkedin_url.
// ----------------------------------------------------------------------------
function splitName(fullName) {
  if (!fullName) return { first: null, last: null };
  const parts = String(fullName).trim().split(/\s+/);
  return { first: parts[0] || null, last: parts.length > 1 ? parts.slice(1).join(' ') : null };
}

export async function enrichByName({ name, firstName, lastName, domain }) {
  const f = firstName || splitName(name).first;
  const l = lastName  || splitName(name).last;
  if (!f || !domain) return null;

  const body = {
    first_name: f,
    domain,
    reveal_personal_emails: true,
  };
  if (l) body.last_name = l;
  // Note: we deliberately omit run_waterfall_email/phone here — those are only
  // useful when Apollo doesn't have the person cached. The findOwner flow in
  // pipeline/run.js already triggers waterfall for the top-of-list contact.
  // Per-additional-contact waterfall would multiply credit cost; users can
  // re-trigger waterfall manually via scripts/trigger-waterfall.js if needed.

  try {
    const { data } = await axios.post(`${APOLLO_BASE}/people/match`, body, {
      headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
      timeout: TIMEOUT,
    });
    const p = data?.person;
    if (!p) return null;
    return {
      apollo_contact_id: p.id || null,
      email: p.email || p.personal_emails?.[0] || null,
      phone:
        p.sanitized_phone ||
        p.phone_numbers?.[0]?.sanitized_number ||
        p.phone_numbers?.[0]?.raw_number ||
        null,
      linkedin_url: p.linkedin_url || null,
      title_apollo: p.title || null,
    };
  } catch (e) {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Orchestrator: run website + LinkedIn discovery in parallel, dedupe by
// lowercased full name (or first if last is missing), then enrich each via
// Apollo /people/match. Returns array of contact objects ready for storage.
// ----------------------------------------------------------------------------
export async function discoverOwners({ companyName, companyUrl, domain }) {
  // Stage 1: website + LinkedIn in parallel (cheap-ish).
  const [siteOwners, liOwners] = await Promise.all([
    findOwnersFromWebsite(companyUrl),
    findOwnersFromLinkedIn(companyName, domain),
  ]);

  // Stage 2: broad Exa search ONLY if stage 1 yielded nothing. Cost discipline:
  // most leads succeed at stage 1, so we don't pay the extra Exa+Haiku cost
  // unnecessarily.
  let broadOwners = [];
  if (siteOwners.length === 0 && liOwners.length === 0) {
    broadOwners = await findOwnersFromBroadSearch(companyName, domain);
  }

  // Dedupe — prefer website source when names match (full names from /team
  // pages tend to be more accurate than LinkedIn search snippets). We key on
  // first-name + last-token of last-name so name variants like "Jessica
  // Blackburn" and "Jessica Evangelist Blackburn" collapse to one entry.
  function dedupKey(name) {
    const parts = String(name || '').toLowerCase().replace(/[^\w\s-]/g, '').split(/\s+/).filter(Boolean);
    if (!parts.length) return '';
    if (parts.length === 1) return parts[0];
    return `${parts[0]}|${parts[parts.length - 1]}`;
  }

  const byKey = new Map();
  for (const o of [...siteOwners, ...liOwners, ...broadOwners]) {
    if (!o?.name) continue;
    const key = dedupKey(o.name);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, o);
    else {
      // Merge: keep first source; fill in missing fields from second. Prefer
      // the LONGER name as the canonical (so "Jessica Evangelist Blackburn"
      // wins over "Jessica Blackburn" if both appear).
      const existing = byKey.get(key);
      const canonicalName = (o.name?.length || 0) > (existing.name?.length || 0) ? o.name : existing.name;
      byKey.set(key, {
        ...o,
        ...existing,
        name: canonicalName,
        linkedin_url: existing.linkedin_url || o.linkedin_url,
        email: existing.email || o.email,
        phone: existing.phone || o.phone,
      });
    }
  }

  // Enrich via Apollo, in series (to be gentle with credits / rate limits).
  const enriched = [];
  for (const o of byKey.values()) {
    const apolloData = await enrichByName({ name: o.name, domain });
    const { first, last } = splitName(o.name);
    enriched.push({
      name: o.name,
      first_name: first,
      last_name: last,
      title: o.title || apolloData?.title_apollo || null,
      email: o.email || apolloData?.email || null,
      phone: o.phone || apolloData?.phone || null,
      linkedin_url: o.linkedin_url || apolloData?.linkedin_url || null,
      apollo_contact_id: apolloData?.apollo_contact_id || null,
      source: o.source,
      confidence: apolloData?.apollo_contact_id ? 'high' : 'medium',
    });
  }
  return enriched;
}
