export default function SourceSelector({ sources, onChange }) {
  function toggle(key) {
    const next = sources.includes(key) ? sources.filter((s) => s !== key) : [...sources, key];
    onChange(next);
  }
  const items = [
    { key: 'exa', label: 'Exa Search', sub: 'Semantic web search across directories, journals, M&A feeds' },
    { key: 'apollo_search', label: 'Apollo Search', sub: 'Claude extracts filters; Apollo Organization Search returns up to 500 companies' },
    { key: 'apollo_list', label: 'Import Apollo List', sub: 'Pull companies from a saved label in your Apollo account' },
    { key: 'csv', label: 'Upload CSV', sub: 'Map columns flexibly; same-domain rows merge into multi-contact leads' },
  ];
  return (
    <div className="source-selector">
      {items.map((it) => (
        <label key={it.key} className={`source-option ${sources.includes(it.key) ? 'on' : ''}`}>
          <input type="checkbox" checked={sources.includes(it.key)} onChange={() => toggle(it.key)} />
          <div>
            <div className="source-option-label">{it.label}</div>
            <div className="source-option-sub muted">{it.sub}</div>
          </div>
        </label>
      ))}
    </div>
  );
}
