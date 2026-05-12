import axios from 'axios';

const BASE = 'https://api.leadmagic.io';
const TIMEOUT = 30_000;

function headers() {
  return {
    'X-API-Key': process.env.LEADMAGIC_API_KEY,
    'Content-Type': 'application/json',
  };
}

function lmErr(e) {
  const status = e.response?.status;
  const body = e.response?.data;
  const msg = body?.error || body?.message || e.message;
  return status ? `${status} ${msg}` : msg;
}

export async function findEmail({ firstName, lastName, companyDomain }) {
  if (!firstName || !lastName || !companyDomain) return null;
  try {
    const { data } = await axios.post(
      `${BASE}/email-finder`,
      { first_name: firstName, last_name: lastName, company_domain: companyDomain },
      { headers: headers(), timeout: TIMEOUT }
    );
    return {
      email: data.email || data.email_address || null,
      status: data.status || data.email_status || null,
    };
  } catch (e) {
    console.warn('[leadmagic] findEmail failed', companyDomain, lmErr(e));
    return null;
  }
}

export async function findMobile({ firstName, lastName, companyDomain }) {
  if (!firstName || !lastName || !companyDomain) return null;
  try {
    const { data } = await axios.post(
      `${BASE}/mobile-finder`,
      { first_name: firstName, last_name: lastName, company_domain: companyDomain },
      { headers: headers(), timeout: TIMEOUT }
    );
    return {
      phone: data.mobile_number || data.phone || data.mobile || null,
      status: data.status || null,
    };
  } catch (e) {
    console.warn('[leadmagic] findMobile failed', companyDomain, lmErr(e));
    return null;
  }
}

// Firmographics fallback — when Apollo's orgEnrich returns nothing for a
// domain, the pipeline falls back to LeadMagic's company search before
// reaching for Claude web search. Returns a row shaped like mapApolloOrgToLead's
// output (subset of fields LeadMagic exposes).
export async function findCompany({ domain }) {
  if (!process.env.LEADMAGIC_API_KEY || !domain) return null;
  try {
    const { data } = await axios.post(
      `${BASE}/company-search`,
      { company_domain: domain },
      { headers: headers(), timeout: TIMEOUT }
    );
    const c = data?.company || data || {};
    if (!c.name && !c.company_name && !c.industry) return null;
    const employees = Number.isFinite(c.employees)
      ? c.employees
      : (Number.isFinite(c.employee_count) ? c.employee_count : null);
    return {
      company_name: c.name || c.company_name || null,
      company_url: c.website || c.website_url || (domain ? `https://${domain}` : null),
      domain,
      industry: c.industry || (Array.isArray(c.industries) ? c.industries[0] : null) || null,
      employees,
      revenue: c.revenue || c.annual_revenue || null,
      location: c.location || [c.city, c.state].filter(Boolean).join(', ') || c.country || null,
      parent_company: c.parent_company || null,
      ownership: c.parent_company ? 'subsidiary' : 'unknown',
      short_description: c.short_description || c.description || null,
      founded_year: Number.isFinite(c.founded_year) ? c.founded_year : null,
      linkedin_url: c.linkedin_url || null,
      twitter_url: c.twitter_url || null,
      facebook_url: c.facebook_url || null,
      keywords: Array.isArray(c.keywords) ? c.keywords : null,
      technologies: Array.isArray(c.technologies) ? c.technologies : null,
      estimated_num_employees: employees,
      annual_revenue_printed: typeof c.revenue === 'string' ? c.revenue : null,
    };
  } catch (e) {
    console.warn('[leadmagic] findCompany failed', domain, lmErr(e));
    return null;
  }
}

function domainFromUrl(url) {
  if (!url) return null;
  const withProto = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try { return new URL(withProto).hostname.replace(/^www\./, ''); } catch { return null; }
}

// Owner-level contact fallback. Called per-owner inside the pipeline once
// Apollo's people-match + waterfall reveal has settled. Returns a partial
// update dict for the `lead_owners` row, or null when nothing was found.
// Never overwrites an existing value.
export async function fallbackContact(owner, { companyDomain } = {}) {
  if (!process.env.LEADMAGIC_API_KEY) return null;
  if (!owner) return null;

  let firstName = owner.first_name;
  let lastName = owner.last_name;
  if ((!firstName || !lastName) && owner.name) {
    const parts = String(owner.name).trim().split(/\s+/);
    firstName = firstName || parts[0] || null;
    lastName = lastName || parts.slice(1).join(' ') || null;
  }

  const domain = companyDomain || domainFromUrl(owner.company_url || owner.linkedin_url);
  if (!firstName || !lastName || !domain) return null;

  const needEmail = !owner.email;
  const needPhone = !owner.phone;
  if (!needEmail && !needPhone) return null;

  const update = {};
  let filled = false;

  if (needEmail) {
    const r = await findEmail({ firstName, lastName, companyDomain: domain });
    if (r?.email) {
      update.email = r.email;
      update.email_status = r.status || 'unknown';
      filled = true;
    }
  }
  if (needPhone) {
    const r = await findMobile({ firstName, lastName, companyDomain: domain });
    if (r?.phone) {
      update.phone = r.phone;
      update.phone_status = r.status || 'unknown';
      filled = true;
    }
  }

  if (!filled) return null;
  update.enrichment_source = 'leadmagic';
  return update;
}
