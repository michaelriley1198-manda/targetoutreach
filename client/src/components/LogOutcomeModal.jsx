import { useState } from 'react';

const OUTCOMES = [
  { value: 'interested', label: 'Interested' },
  { value: 'not_interested', label: 'Not interested' },
  { value: 'callback', label: 'Callback' },
  { value: 'wrong_person', label: 'Wrong person' },
];

export default function LogOutcomeModal({ lead, talkSeconds, onSubmit, onSkip }) {
  const [outcome, setOutcome] = useState('interested');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await onSubmit({ outcome_label: outcome, notes, talk_seconds: talkSeconds });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Log call outcome</h3>
        <p className="muted small">
          {lead?.company_name} — {lead?.contact_name || '—'} · talked {talkSeconds}s
        </p>
        <label className="field">
          <span>Outcome</span>
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            {OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Notes</span>
          <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What did they say?" />
        </label>
        <div className="row">
          <button className="primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save & next'}</button>
          <button className="ghost" onClick={onSkip} disabled={busy}>Skip log</button>
        </div>
      </div>
    </div>
  );
}
