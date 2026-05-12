import { parse as parseSync } from 'csv-parse/sync';

// Flexible header alias map. Lowercase + trim before lookup. Keys map to the
// canonical field names used by mapApolloOrgToLead so the merge step in the
// pipeline doesn't need source-specific branches.
const ALIASES = {
  company_name: ['company', 'company name', 'business name', 'organization', 'org', 'account', 'account name'],
  domain: ['domain', 'website', 'url', 'company website', 'company url', 'web'],
  city: ['city', 'town'],
  state: ['state', 'state/province', 'province', 'region'],
  industry: ['industry', 'sector', 'vertical'],
  revenue: ['revenue', 'annual revenue', 'sales'],
  employees: ['employees', 'employee count', 'headcount', '# employees', 'staff'],
  contact_name: ['contact name', 'name', 'full name', 'contact'],
  first_name: ['first name', 'firstname', 'fname'],
  last_name: ['last name', 'lastname', 'lname', 'surname'],
  title: ['title', 'role', 'job title', 'position'],
  phone: ['phone', 'phone number', 'mobile', 'cell', 'direct phone'],
  email: ['email', 'email address', 'work email'],
};

function buildHeaderMap(headers) {
  const map = {}; // header (raw) → canonical key
  const lc = headers.map((h) => String(h || '').toLowerCase().trim());
  for (const [canonical, aliases] of Object.entries(ALIASES)) {
    for (let i = 0; i < lc.length; i++) {
      if (aliases.includes(lc[i])) {
        map[headers[i]] = canonical;
        break;
      }
    }
  }
  return map;
}

function normalizeDomain(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].split('?')[0];
  return s.toLowerCase() || null;
}

function toInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

export function parseCsvBuffer(buffer) {
  const text = buffer.toString('utf8');
  const records = parseSync(text, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    relax_quotes: true,
  });
  const headers = records.length ? Object.keys(records[0]) : [];
  return { rows: records, headers };
}

// Transform parsed rows into the canonical lead-row shape. Same-domain rows
// merge into a single lead with a multi-entry contacts[] array (primary = first
// row's contact). Rows without a domain dedup by normalized company name.
export function mapRowsToLeads(rows, headers) {
  const headerMap = buildHeaderMap(headers || (rows[0] ? Object.keys(rows[0]) : []));
  const byKey = new Map();

  rows.forEach((raw, idx) => {
    const row = {};
    for (const [src, canonical] of Object.entries(headerMap)) {
      row[canonical] = raw[src];
    }

    const companyName = (row.company_name || '').toString().trim();
    const domain = normalizeDomain(row.domain);
    const key = domain || (companyName ? `name:${companyName.toLowerCase()}` : `row:${idx}`);

    const firstName = row.first_name || (row.contact_name ? String(row.contact_name).split(' ')[0] : null);
    const lastName = row.last_name || (row.contact_name ? String(row.contact_name).split(' ').slice(1).join(' ') || null : null);
    const name = row.contact_name || [firstName, lastName].filter(Boolean).join(' ') || null;

    const contact = (name || row.email || row.phone) ? {
      name,
      first_name: firstName || null,
      last_name: lastName || null,
      title: row.title || null,
      email: row.email || null,
      phone: row.phone || null,
      source: 'csv',
    } : null;

    if (byKey.has(key)) {
      const existing = byKey.get(key);
      if (contact) existing.contacts.push(contact);
      // Fill any missing firmographic fields from later rows
      for (const f of ['industry', 'revenue', 'location', 'employees', 'company_url']) {
        if (!existing[f] && row[f]) existing[f] = row[f];
      }
      return;
    }

    const city = row.city ? String(row.city).trim() : null;
    const state = row.state ? String(row.state).trim() : null;
    const location = [city, state].filter(Boolean).join(', ') || null;

    byKey.set(key, {
      company_name: companyName || null,
      company_url: domain ? `https://${domain}` : null,
      domain,
      industry: row.industry || null,
      revenue: row.revenue || null,
      employees: toInt(row.employees),
      location,
      contacts: contact ? [contact] : [],
      _csvRowIdx: idx,
    });
  });

  return Array.from(byKey.values());
}

export function getMappedColumns(headers) {
  return buildHeaderMap(headers);
}
