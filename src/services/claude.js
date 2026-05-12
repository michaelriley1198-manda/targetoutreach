import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.APP_ANTHROPIC_API_KEY });

// Query generation benefits from Opus's diversity; per-lead research is a
// structured-classification task that Haiku handles fine at ~5x lower cost.
const MODEL_QUERIES = 'claude-opus-4-7';
const MODEL_RESEARCH = 'claude-haiku-4-5-20251001';

function extractJson(text) {
  if (!text) return null;
  // strip markdown fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // try first {...} or [...] in the text
    const first = candidate.search(/[{[]/);
    if (first === -1) return null;
    const last = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (last === -1) return null;
    try {
      return JSON.parse(candidate.slice(first, last + 1));
    } catch {
      return null;
    }
  }
}

// Plain-string variant — used by query generation where caching isn't useful
// (one call per batch).
async function callJsonPlain(system, user, { maxTokens = 4096, model = MODEL_QUERIES } = {}) {
  const res = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
  return { json: extractJson(text), raw: text };
}

// Cached variant — the system prompt + campaign-brief preamble are marked as
// ephemeral cache. Across N research calls in a batch, the system+brief get
// cached once and reused. Cache hits cost ~10% of normal input tokens.
async function callJsonCached({ systemPrompt, briefPrefix, perCallSuffix, maxTokens = 2500, model = MODEL_RESEARCH }) {
  const res = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: briefPrefix, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: perCallSuffix },
      ],
    }],
  });
  const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
  return { json: extractJson(text), raw: text };
}

export async function generateSearchQueries(prompt, { numQueries = 20, excludeQueries = [] } = {}) {
  const exclusionsBlock = excludeQueries.length
    ? `\n\nThe following queries have ALREADY been run and returned results — your new queries MUST be semantically distinct from these to discover new sources:\n${excludeQueries.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\nDo not repeat or paraphrase any of the above. Push into different discovery vectors, geographies, niches, time windows, or signal types.`
    : '';

  const system = `You are a private equity deal sourcing expert. Generate ${numQueries} diverse Exa.ai neural search queries to discover acquisition targets and intermediaries based on the user's brief.

Each query should target a different discovery vector. Cover the full surface — direct company sites, industry directories, ranking lists, local business journals, succession/retirement news, trade publications, conference speakers, LinkedIn profiles, M&A announcements (related not yet acquired), review sites, and customer-signal pages. Vary geographies, sub-niches, and signal phrasings.${exclusionsBlock}

Return STRICT JSON only — no prose, no fences. Format: {"queries": ["query 1", "query 2", ...]} with exactly ${numQueries} strings.`;

  const { json } = await callJsonPlain(system, prompt, { maxTokens: Math.max(2048, numQueries * 80) });
  if (!json?.queries || !Array.isArray(json.queries)) {
    throw new Error('Claude did not return a valid queries array');
  }
  return json.queries.slice(0, numQueries);
}

// ----------------------------------------------------------------------------
// Two-phase research:
//  Phase 1 (filterLead) — cheap pass that decides PASS/FAIL + key bucketing fields.
//                         Most leads FAIL here so we never pay for the rich profile.
//  Phase 2 (enrichLeadProfile) — runs only for PASS leads. Produces description,
//                                fit_rationale, flags, bio_json, financials, etc.
// Both share the system+brief preamble (cached).
// ----------------------------------------------------------------------------

const FILTER_SYSTEM = `You are a private equity diligence analyst making a fast PASS/FAIL classification on a single web result against the campaign brief.

Return STRICT JSON only — no prose, no fences — with exactly these fields:

{
  "company_name": "name of the entity that owns the URL in RAW WEB DATA. If the URL is a parent/holding company (e.g. tibbscapitalgroup.com), use the holding company's name — do NOT substitute an operating subsidiary. If unsure, return 'Unknown'.",
  "company_url": "the URL from RAW WEB DATA, verbatim",
  "fit_score": 3 | 4 | 5,
  "pass_fail": "PASS" | "FAIL",
  "priority_score": integer 0-100,
  "industry": string,
  "location": "City, ST",
  "ownership": "founder-owned" | "family-owned" | "PE-backed" | "VC-backed" | "public" | "unknown",
  "fail_reason": "if FAIL, one short sentence explaining why; if PASS, ''"
}

Hard rules:
- pass_fail = FAIL if PE/VC/institutional backing, outside the brief's size range, or wrong geography.
- fit_score 5 = strong match; 4 = good with minor gaps; 3 = moderate with meaningful gaps. If the company doesn't meet the floor, return fit_score 3 + pass_fail FAIL.
- priority_score weighted: criteria match 40%, size fit 30%, transition signals 20%, geography 10%.

Be ruthless on FAIL — the bar is high.`;

const ENRICH_SYSTEM = `You are a private equity diligence analyst producing the deep profile for a lead that has already passed an initial fit filter.

Return STRICT JSON only — no prose, no fences — with exactly these fields:

{
  "description": "2-3 sentences: what they do, founding year, employee count, revenue if available, services, customer types",
  "fit_rationale": "3-5 sentences mapping specific company attributes to specific criteria from the brief. Call out must-have and nice-to-have matches explicitly",
  "vertical_signal": "comma-separated industries/verticals served",
  "flags": "Specific concerns or qualification items: employee/revenue mismatches, PE ownership signals, revenue mix questions, geographic concerns. Be specific, not generic. If none, say 'None identified'",
  "revenue": "estimated revenue (e.g., '$5-10M') or 'Unknown'",
  "ebitda": "estimated ebitda or 'Unknown'",
  "employees": integer or null,
  "bio_json": {
    "ice_breakers": ["3-5 personal facts about owner/CEO: alma mater, hobbies, community, family, interests"],
    "industry_news": ["3-4 recent industry developments they'd care about"],
    "talking_points": ["3-4 strategic observations on why NOW is right for a conversation: age, succession, market consolidation, growth challenges"]
  }
}

Be honest about gaps and surface conflicts (e.g., 200 employees but $3M revenue) in flags.`;

function buildPerCall(exaResult) {
  return `RAW WEB DATA:
URL: ${exaResult.url}
Title: ${exaResult.title || ''}
Snippet/Text: ${(exaResult.text || '').slice(0, 4000)}
Highlights: ${(exaResult.highlights || []).join(' | ')}
Domain: ${exaResult.domain || ''}

Produce the JSON now.`;
}

export async function filterLead({ campaignPrompt, exaResult }) {
  const briefPrefix = `CAMPAIGN BRIEF:\n${campaignPrompt}\n\n---\n`;
  const { json } = await callJsonCached({
    systemPrompt: FILTER_SYSTEM,
    briefPrefix,
    perCallSuffix: buildPerCall(exaResult),
    maxTokens: 600,
    model: MODEL_RESEARCH,
  });
  return json;
}

// Extract structured Apollo Organization Search filters from a free-form
// campaign brief. The wizard surfaces the JSON back to the user via the
// ApolloFilterPreview component so they can edit before launch.
const APOLLO_FILTER_SYSTEM = `You translate a private-equity campaign brief into structured filters for Apollo's Organization Search API.

Return STRICT JSON only — no prose, no fences — with exactly these fields:

{
  "industries": ["short industry tags Apollo would tag, e.g. 'paving', 'hvac', 'electrical services'"],
  "employee_range": { "min": int_or_null, "max": int_or_null },
  "revenue_range": { "min_usd": int_or_null, "max_usd": int_or_null },
  "locations": ["State or 'City, ST' strings, US-only unless the brief says otherwise"],
  "keywords": ["additional positive keywords the brief mentions (services, niches, customer types)"],
  "exclude_keywords": ["disqualifiers from the brief, e.g. 'franchise', 'PE-backed'"]
}

Rules:
- If the brief doesn't specify a range, set the field to null (not 0).
- Convert size hints to numbers: "$2-10M EBITDA" → revenue_range.min_usd: 10_000_000, max_usd: 50_000_000 (rough 5x multiple unless brief says revenue directly).
- Be parsimonious — fewer, sharper keywords beat long lists.`;

export async function extractApolloFilters(prompt) {
  const { json } = await callJsonPlain(APOLLO_FILTER_SYSTEM, prompt, {
    maxTokens: 800,
    model: MODEL_RESEARCH,
  });
  if (!json) throw new Error('Claude did not return valid Apollo filter JSON');
  return {
    industries: Array.isArray(json.industries) ? json.industries : [],
    employee_range: json.employee_range || { min: null, max: null },
    revenue_range: json.revenue_range || { min_usd: null, max_usd: null },
    locations: Array.isArray(json.locations) ? json.locations : [],
    keywords: Array.isArray(json.keywords) ? json.keywords : [],
    exclude_keywords: Array.isArray(json.exclude_keywords) ? json.exclude_keywords : [],
  };
}

// Build the per-call user text from a firmographics row (Apollo / LeadMagic /
// claude-web-search shape). Used when there's no Exa snippet to lean on.
function buildPerCallFromFirmographics(firm) {
  if (!firm) return '';
  const lines = [
    `Company: ${firm.company_name || '(unknown)'}`,
    `URL: ${firm.company_url || ''}`,
    `Domain: ${firm.domain || ''}`,
    `Industry: ${firm.industry || ''}`,
    `Employees: ${firm.employees ?? firm.estimated_num_employees ?? ''}`,
    `Revenue: ${firm.revenue || firm.annual_revenue_printed || ''}`,
    `Location: ${firm.location || ''}`,
    `Ownership: ${firm.ownership || ''}`,
    `Parent company: ${firm.parent_company || ''}`,
    `Founded: ${firm.founded_year || ''}`,
    `NAICS: ${(firm.naics_codes || []).join(', ')}`,
    `SIC: ${(firm.sic_codes || []).join(', ')}`,
    `Keywords: ${(firm.keywords || []).slice(0, 30).join(', ')}`,
    `Technologies: ${(firm.technologies || []).slice(0, 30).join(', ')}`,
    `Short description: ${firm.short_description || ''}`,
  ].filter((l) => l.split(':').slice(1).join(':').trim());
  return `STRUCTURED FIRMOGRAPHICS:\n${lines.join('\n')}\n\nProduce the JSON now.`;
}

export async function enrichLeadProfile({ campaignPrompt, exaResult, firmographics }) {
  const briefPrefix = `CAMPAIGN BRIEF:\n${campaignPrompt}\n\n---\n`;
  const perCallSuffix = exaResult
    ? buildPerCall(exaResult)
    : buildPerCallFromFirmographics(firmographics);
  const { json } = await callJsonCached({
    systemPrompt: ENRICH_SYSTEM,
    briefPrefix,
    perCallSuffix,
    maxTokens: 2000,
    model: MODEL_RESEARCH,
  });
  return json;
}

// ----------------------------------------------------------------------------
// Cheap preliminary scorer — runs on EVERY merged lead after Apollo/LeadMagic
// firmographics enrichment, regardless of source. Source-agnostic: no Exa
// snippet required, just the structured firmographics row. ~150 output tokens
// max; system+brief are cached so per-batch cost stays well under filterLead's.
//
// Returned JSON: { pass_fail, priority_score, fit_score, ownership, reason }
// ----------------------------------------------------------------------------
const FIRM_SCORE_SYSTEM = `You are a private equity diligence analyst classifying a single company against the campaign brief, using ONLY structured firmographics (industry, employees, revenue, location, parent company, keywords, NAICS, etc.). No web text is provided.

Return STRICT JSON only — no prose, no fences — with exactly these fields:

{
  "pass_fail": "PASS" | "FAIL",
  "priority_score": integer 0-100,
  "fit_score": 3 | 4 | 5,
  "ownership": "founder-owned" | "family-owned" | "PE-backed" | "VC-backed" | "public" | "subsidiary" | "unknown",
  "reason": "one short sentence — why pass/fail at this score"
}

Hard rules:
- FAIL if parent_company is non-empty (subsidiary / rolled up).
- FAIL if size is clearly outside the brief's range.
- FAIL if industry / keywords are clearly off the brief's verticals.
- PASS with priority_score >= 51 ONLY when the firmographics show a strong vertical + size match. Borderline rows should land 30-50.
- priority_score weighted: vertical match 40%, size fit 30%, geography 20%, ownership signals 10%.
- fit_score 5 = strong, 4 = good, 3 = moderate. Below 3 means FAIL.

Be conservative — we run a more expensive Claude pass on rows scoring above 50.`;

export async function scoreLeadFromFirmographics({ campaignPrompt, firmographics }) {
  if (!firmographics) return null;
  const briefPrefix = `CAMPAIGN BRIEF:\n${campaignPrompt}\n\n---\n`;
  const { json } = await callJsonCached({
    systemPrompt: FIRM_SCORE_SYSTEM,
    briefPrefix,
    perCallSuffix: buildPerCallFromFirmographics(firmographics),
    maxTokens: 200,
    model: MODEL_RESEARCH,
  });
  if (!json) return null;
  return {
    pass_fail: json.pass_fail === 'PASS' ? 'PASS' : 'FAIL',
    priority_score: Number.isFinite(json.priority_score) ? json.priority_score : 0,
    fit_score: Number.isFinite(json.fit_score) ? json.fit_score : 3,
    ownership: json.ownership || firmographics.ownership || 'unknown',
    reason: json.reason || '',
  };
}

// ----------------------------------------------------------------------------
// Claude web-search firmographics fallback — invoked when both Apollo's
// orgEnrich and LeadMagic's company-search return nothing for a domain.
// Uses Haiku with the web_search server-side tool to extract a minimal set of
// firmographics from public pages so the row can still be scored.
// ----------------------------------------------------------------------------
const WEBSEARCH_SYSTEM = `You are a private equity research assistant. Given a company name + URL, use web search to find this company's basic firmographics. Return STRICT JSON only — no prose, no fences:

{
  "industry": string,
  "revenue": "rough range like '$5-10M' or 'Unknown'",
  "employees": integer or null,
  "location": "City, ST" or null,
  "ownership": "founder-owned" | "family-owned" | "PE-backed" | "VC-backed" | "public" | "subsidiary" | "unknown",
  "parent_company": string or null,
  "short_description": "1-2 sentences on what they do",
  "founded_year": integer or null
}

If the company can't be located, return all-null fields plus ownership='unknown'.`;

export async function webSearchFirmographics({ companyName, companyUrl, domain }) {
  if (!companyName && !companyUrl) return null;
  try {
    const userText = `Company: ${companyName || '(unknown)'}\nURL: ${companyUrl || ''}\nDomain: ${domain || ''}\n\nResearch this company via web search and return the JSON now.`;
    const res = await client.messages.create({
      model: MODEL_RESEARCH,
      max_tokens: 1200,
      system: WEBSEARCH_SYSTEM,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      messages: [{ role: 'user', content: userText }],
    });
    // Walk content blocks for the final text payload (Claude may interleave
    // tool_use/tool_result blocks before the answer).
    const textBlock = (res.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const json = extractJson(textBlock);
    if (!json) return null;
    return {
      company_name: companyName || null,
      company_url: companyUrl || (domain ? `https://${domain}` : null),
      domain: domain || null,
      industry: json.industry || null,
      employees: Number.isFinite(json.employees) ? json.employees : null,
      revenue: json.revenue || null,
      location: json.location || null,
      ownership: json.ownership || 'unknown',
      parent_company: json.parent_company || null,
      short_description: json.short_description || null,
      founded_year: Number.isFinite(json.founded_year) ? json.founded_year : null,
    };
  } catch (e) {
    console.warn('[claude] webSearchFirmographics failed', domain || companyUrl, e.message);
    return null;
  }
}
