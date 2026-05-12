import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function ApolloListPicker({ selectedId, onSelect }) {
  const [labels, setLabels] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.listApolloLabels()
      .then(({ labels }) => setLabels(labels || []))
      .catch((e) => setErr(e.message));
  }, []);

  if (err) return <div className="error">{err}</div>;
  if (!labels) return <div className="muted">Loading your Apollo lists…</div>;
  if (!labels.length) return <div className="muted">No saved lists found in your Apollo account.</div>;

  return (
    <label className="field">
      <span>Apollo saved list</span>
      <select
        value={selectedId || ''}
        onChange={(e) => {
          const l = labels.find((x) => x.id === e.target.value);
          onSelect(l ? { id: l.id, name: l.name } : null);
        }}
      >
        <option value="">— Pick a list —</option>
        {labels.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name} {l.type ? `(${l.type})` : ''}{l.cached_count != null ? ` — ${l.cached_count}` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
