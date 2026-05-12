import axios from 'axios';

const EXA_URL = 'https://api.exa.ai/search';

export async function exaSearch(query, { numResults = 10, type = 'neural' } = {}) {
  const { data } = await axios.post(
    EXA_URL,
    {
      query,
      type,
      numResults,
      contents: { text: { maxCharacters: 1500 }, highlights: true },
    },
    {
      headers: {
        'x-api-key': process.env.EXA_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 60_000,
    }
  );
  return data.results || [];
}

export async function exaSearchAll(queries, onProgress, { numResults = 10 } = {}) {
  let done = 0;
  let errorCount = 0;
  const settled = await Promise.all(
    queries.map((q) =>
      exaSearch(q, { numResults })
        .then((r) => {
          done++;
          onProgress?.({ done, total: queries.length, errorCount });
          return { ok: true, results: r };
        })
        .catch((e) => {
          done++;
          errorCount++;
          console.warn('[exa] query failed:', q, e.message);
          onProgress?.({ done, total: queries.length, errorCount });
          return { ok: false, error: e.message };
        })
    )
  );

  const seen = new Set();
  const merged = [];
  for (const r of settled) {
    if (!r.ok) continue;
    for (const item of r.results) {
      try {
        const domain = new URL(item.url).hostname.replace(/^www\./, '');
        if (seen.has(domain)) continue;
        seen.add(domain);
        merged.push({ ...item, domain });
      } catch {
        // skip malformed urls
      }
    }
  }
  return merged;
}
