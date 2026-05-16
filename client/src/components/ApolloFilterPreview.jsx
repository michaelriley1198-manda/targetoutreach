import { useEffect, useState } from 'react';
import { api } from '../api.js';

function ChipInput({ value = [], onChange, placeholder }) {
  const [draft, setDraft] = useState('');
  function commit() {
    const t = draft.trim();
    if (!t) return;
    if (!value.includes(t)) onChange([...value, t]);
    setDraft('');
  }
  return (
    <div className="chip-input">
      {value.map((c, i) => (
        <span key={i} className="chip">
          {c}
          <button type="button" onClick={() => onChange(value.filter((_, x) => x !== i))}>×</button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); } }}
        onBlur={commit}
        placeholder={placeholder}
      />
    </div>
  );
}

export default function ApolloFilterPreview({ prompt, filters, onChange }) {
  const [loading, setLoading] = useState(!filters);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [preview, setPreview] = useState([]);
  const [totalSampled, setTotalSampled] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (filters || !prompt) return;
    setLoading(true);
    api.previewApolloFilters(prompt)
      .then(({ filters: f }) => { onChange(f); setLoading(false); })
      .catch((e) => { setErr(e.message); setLoading(false); });
    // eslint-disable-next-line
  }, [prompt]);

  async function runPreview() {
    if (!filters) return;
    setPreviewBusy(true); setErr(null);
    try {
      const { sample, total_sampled } = await api.previewApolloSearch(filters, 25);
      setPreview(sample);
      setTotalSampled(total_sampled);
    } catch (e) { setErr(e.message); }
    finally { setPreviewBusy(false); }
  }

  function set(field, v) { onChange({ ...filters, [field]: v }); }
  function setRange(field, key, v) { onChange({ ...filters, [field]: { ...(filters[field] || {}), [key]: v } }); }

  if (loading) return <div className="muted">Extracting Apollo filters from your brief…</div>;
  if (!filters) return <div className="error">{err || 'Filter extraction failed'}</div>;

  return (
    <div className="apollo-filter-preview">
      {err && <div className="error">{err}</div>}
      <label className="field">
        <span>Industries / keywords (Apollo tags)</span>
        <ChipInput value={filters.industries || []} onChange={(v) => set('industries', v)} placeholder="Press Enter to add" />
      </label>
      <div className="row gap">
        <label className="field">
          <span>Employees min</span>
          <input type="number" value={filters.employee_range?.min ?? ''}
            onChange={(e) => setRange('employee_range', 'min', e.target.value ? parseInt(e.target.value, 10) : null)} />
        </label>
        <label className="field">
          <span>Employees max</span>
          <input type="number" value={filters.employee_range?.max ?? ''}
            onChange={(e) => setRange('employee_range', 'max', e.target.value ? parseInt(e.target.value, 10) : null)} />
        </label>
      </div>
      <div className="row gap">
        <label className="field">
          <span>Revenue min (USD)</span>
          <input type="number" value={filters.revenue_range?.min_usd ?? ''}
            onChange={(e) => setRange('revenue_range', 'min_usd', e.target.value ? parseInt(e.target.value, 10) : null)} />
        </label>
        <label className="field">
          <span>Revenue max (USD)</span>
          <input type="number" value={filters.revenue_range?.max_usd ?? ''}
            onChange={(e) => setRange('revenue_range', 'max_usd', e.target.value ? parseInt(e.target.value, 10) : null)} />
        </label>
      </div>
      <label className="field">
        <span>Locations</span>
        <ChipInput value={filters.locations || []} onChange={(v) => set('locations', v)} placeholder='e.g. "Texas", "Miami, FL"' />
      </label>
      <label className="field">
        <span>Extra keywords</span>
        <ChipInput value={filters.keywords || []} onChange={(v) => set('keywords', v)} placeholder="Press Enter to add" />
      </label>
      <label className="field">
        <span>Exclude keywords</span>
        <ChipInput value={filters.exclude_keywords || []} onChange={(v) => set('exclude_keywords', v)} placeholder='e.g. "franchise"' />
      </label>

      <button type="button" className="ghost" onClick={runPreview} disabled={previewBusy}>
        {previewBusy ? 'Previewing…' : 'Preview ~25 companies'}
      </button>

      {preview.length > 0 && (
        <div className="preview-list">
          <div className="muted">Showing {preview.length} of {totalSampled ?? preview.length} companies Apollo returned (page 1 only — full run fetches up to 5 pages):</div>
          <ul>
            {preview.map((p, i) => (
              <li key={i}>
                <b>{p.company_name}</b> — {p.industry || '—'} · {p.employees || '?'} emp · {p.location || '—'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
