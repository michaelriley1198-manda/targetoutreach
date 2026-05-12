import { useState } from 'react';
import { api } from '../api.js';

export default function CsvUploader({ preview, onPreview }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const result = await api.uploadCsvPreview(file);
      onPreview(result);
    } catch (er) { setErr(er.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="csv-uploader">
      {err && <div className="error">{err}</div>}
      <label className="field">
        <span>CSV file</span>
        <input type="file" accept=".csv,text/csv" onChange={handleFile} disabled={busy} />
        {busy && <span className="muted">Parsing…</span>}
      </label>

      {preview && (
        <div className="csv-preview">
          <div className="row">
            <b>{preview.filename}</b>
            <span className="muted">
              {preview.total_rows} rows → {preview.deduped_leads} leads (after same-domain merge)
            </span>
          </div>

          <div className="muted" style={{ marginTop: 8 }}>Column mapping:</div>
          <ul className="column-map">
            {preview.headers.map((h) => (
              <li key={h}>
                <code>{h}</code>
                {preview.mapped_columns[h] ? (
                  <span> → <b>{preview.mapped_columns[h]}</b></span>
                ) : (
                  <span className="muted"> → (unmapped, ignored)</span>
                )}
              </li>
            ))}
          </ul>

          <details>
            <summary>First 10 rows</summary>
            <pre style={{ maxHeight: 200, overflow: 'auto' }}>
              {JSON.stringify(preview.sample_rows, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}
