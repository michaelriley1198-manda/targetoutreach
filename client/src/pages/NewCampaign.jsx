import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import SourceSelector from '../components/SourceSelector.jsx';
import ApolloFilterPreview from '../components/ApolloFilterPreview.jsx';
import ApolloListPicker from '../components/ApolloListPicker.jsx';
import CsvUploader from '../components/CsvUploader.jsx';

export default function NewCampaign() {
  const nav = useNavigate();

  // Step 1 — brief
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [sizeFilter, setSizeFilter] = useState('');
  const [geoFilter, setGeoFilter] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [targetLeads, setTargetLeads] = useState(150);
  const [minScore, setMinScore] = useState(50);
  const [maxBatches, setMaxBatches] = useState(4);
  const [excludedAcquirers, setExcludedAcquirers] = useState('');
  const [requireIndependent, setRequireIndependent] = useState(true);

  // Step 2 — sources
  const [sources, setSources] = useState(['exa']);
  const [exaQueries, setExaQueries] = useState(null);
  const [apolloFilters, setApolloFilters] = useState(null);
  const [apolloList, setApolloList] = useState(null);
  const [csvPreview, setCsvPreview] = useState(null);

  // Shared
  const [campaign, setCampaign] = useState(null);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const fullPrompt = () => {
    let p = prompt.trim();
    if (sizeFilter.trim()) p += `\n\nSize criteria: ${sizeFilter.trim()}`;
    if (geoFilter.trim()) p += `\nGeography: ${geoFilter.trim()}`;
    return p;
  };

  async function goToStep2() {
    setBusy(true); setErr(null);
    try {
      const c = campaign || await api.createCampaign({
        name,
        prompt: fullPrompt(),
        target_lead_count: targetLeads,
        min_priority_score: minScore,
        max_search_batches: maxBatches,
        excluded_acquirers: excludedAcquirers.split(',').map((s) => s.trim()).filter(Boolean),
        require_independent: requireIndependent,
        lead_sources: sources,
      });
      setCampaign(c);
      setStep(2);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function generateExaQueries() {
    setBusy(true); setErr(null);
    try {
      const { queries } = await api.generatePrompts(campaign.id);
      setExaQueries(queries);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  function updateQuery(i, v) {
    const next = [...exaQueries]; next[i] = v; setExaQueries(next);
  }

  function canAdvanceFromStep2() {
    if (!sources.length) return false;
    if (sources.includes('exa') && !exaQueries) return false;
    if (sources.includes('apollo_search') && !apolloFilters) return false;
    if (sources.includes('apollo_list') && !apolloList) return false;
    if (sources.includes('csv') && !csvPreview) return false;
    return true;
  }

  async function goToStep3() {
    setBusy(true); setErr(null);
    try {
      // Persist source configs on the campaign before launching
      const patch = { lead_sources: sources };
      if (sources.includes('apollo_search')) patch.apollo_filter_json = apolloFilters;
      if (sources.includes('apollo_list')) {
        patch.apollo_list_id = apolloList.id;
        patch.apollo_list_name = apolloList.name;
      }
      await api.updateCampaign(campaign.id, patch);
      // Reload for fresh defaults
      const fresh = await api.getCampaign(campaign.id);
      setCampaign(fresh);
      setStep(3);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function launch(opts = {}) {
    setBusy(true); setErr(null);
    try {
      await api.launch(campaign.id, exaQueries, {
        skipEnrichment: opts.skipEnrichment,
        csvStagingId: csvPreview?.staging_id || null,
      });
      nav(`/campaigns/${campaign.id}`);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="form-page">
      <h1>New Campaign</h1>
      <div className="wizard-progress">
        {['Brief', 'Sources', 'Outreach', 'Launch'].map((label, i) => (
          <span key={label} className={`wizard-step ${step === i + 1 ? 'active' : ''} ${step > i + 1 ? 'done' : ''}`}>
            {i + 1}. {label}
          </span>
        ))}
      </div>
      {err && <div className="error">{err}</div>}

      {step === 1 && (
        <div className="form">
          <label>
            <span>Campaign name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="HVAC roll-up – Sunbelt" />
          </label>
          <label>
            <span>Brief / prompt</span>
            <textarea rows={8} value={prompt} onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe what you're looking for: targets, intermediaries, sectors, criteria, deal-breakers…" />
          </label>
          <label>
            <span>Size criteria (optional)</span>
            <input value={sizeFilter} onChange={(e) => setSizeFilter(e.target.value)}
              placeholder="$2-10M EBITDA, 20-200 employees" />
          </label>
          <label>
            <span>Geography (optional)</span>
            <input value={geoFilter} onChange={(e) => setGeoFilter(e.target.value)}
              placeholder="Texas, Florida, Arizona" />
          </label>
          <label>
            <span>Excluded acquirers (optional)</span>
            <input value={excludedAcquirers} onChange={(e) => setExcludedAcquirers(e.target.value)}
              placeholder="Pave America, Driveway Maintenance Inc" />
            <small className="muted">Comma-separated. Leads owned by any of these will be FAIL'd.</small>
          </label>
          <label className="checkbox-label">
            <input type="checkbox" checked={requireIndependent}
              onChange={(e) => setRequireIndependent(e.target.checked)} />
            <span>Require independent companies (FAIL any lead with a parent company)</span>
          </label>

          <button type="button" className="ghost" onClick={() => setShowAdvanced(!showAdvanced)}>
            {showAdvanced ? '▾' : '▸'} Advanced
          </button>
          {showAdvanced && (
            <div className="advanced-panel">
              <label>
                <span>Target lead count (Exa cap when no imports selected)</span>
                <input type="number" min={10} max={500} value={targetLeads}
                  onChange={(e) => setTargetLeads(parseInt(e.target.value, 10) || 150)} />
              </label>
              <label>
                <span>Minimum priority score (0–100)</span>
                <input type="number" min={0} max={100} value={minScore}
                  onChange={(e) => setMinScore(parseInt(e.target.value, 10) || 50)} />
              </label>
              <label>
                <span>Max Exa search batches</span>
                <input type="number" min={1} max={10} value={maxBatches}
                  onChange={(e) => setMaxBatches(parseInt(e.target.value, 10) || 4)} />
              </label>
            </div>
          )}

          <button className="primary" disabled={busy || !name.trim() || !prompt.trim()} onClick={goToStep2}>
            {busy ? 'Saving…' : 'Continue to Sources →'}
          </button>
        </div>
      )}

      {step === 2 && (
        <div>
          <h2>Lead Sources</h2>
          <p className="muted">Pick any combination. Results merge and dedupe by domain. Apollo Search/List and CSV imports bypass the target lead cap.</p>

          <SourceSelector sources={sources} onChange={setSources} />

          {sources.includes('exa') && (
            <div className="source-panel">
              <h3>Exa Search</h3>
              {!exaQueries && (
                <button className="primary" disabled={busy} onClick={generateExaQueries}>
                  {busy ? 'Generating…' : 'Generate search queries'}
                </button>
              )}
              {exaQueries && (
                <>
                  <p className="muted">Edit any of these before continuing. The pipeline runs this batch first, then auto-generates fresh batches.</p>
                  <ol className="queries">
                    {exaQueries.map((q, i) => (
                      <li key={i}><input value={q} onChange={(e) => updateQuery(i, e.target.value)} /></li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          )}

          {sources.includes('apollo_search') && (
            <div className="source-panel">
              <h3>Apollo Organization Search</h3>
              <ApolloFilterPreview prompt={fullPrompt()} filters={apolloFilters} onChange={setApolloFilters} />
            </div>
          )}

          {sources.includes('apollo_list') && (
            <div className="source-panel">
              <h3>Apollo Saved List</h3>
              <ApolloListPicker selectedId={apolloList?.id} onSelect={setApolloList} />
            </div>
          )}

          {sources.includes('csv') && (
            <div className="source-panel">
              <h3>CSV Upload</h3>
              <CsvUploader preview={csvPreview} onPreview={setCsvPreview} />
            </div>
          )}

          <div className="row" style={{ marginTop: 16 }}>
            <button className="primary" disabled={busy || !canAdvanceFromStep2()} onClick={goToStep3}>
              {busy ? 'Saving…' : 'Continue to Outreach →'}
            </button>
            <button className="ghost" disabled={busy} onClick={() => setStep(1)}>Back</button>
          </div>
        </div>
      )}

      {step === 3 && campaign && (
        <ContentReviewStep
          campaign={campaign}
          onCampaignUpdate={setCampaign}
          onLaunch={(opts) => { setStep(4); return launch(opts); }}
          onBack={() => setStep(2)}
          busy={busy}
        />
      )}

      {step === 4 && (
        <div className="form">
          <h2>Launching campaign…</h2>
          <p className="muted">You'll be redirected to the campaign detail page momentarily.</p>
        </div>
      )}
    </div>
  );
}

function ContentReviewStep({ campaign, onCampaignUpdate, onLaunch, onBack, busy: parentBusy }) {
  const [skipEnrichment, setSkipEnrichment] = useState(false);
  const [seq, setSeq] = useState(campaign.sequence_config || []);
  const [templates, setTemplates] = useState(() => {
    const emailCount = (campaign.sequence_config || []).filter((s) => s?.type === 'email').length;
    const arr = [...(campaign.email_templates || [])];
    while (arr.length < emailCount) arr.push({ subject: '', body: '' });
    return arr.slice(0, emailCount);
  });
  const [vmScripts, setVmScripts] = useState(() => {
    const callCount = (campaign.sequence_config || []).filter((s) => s?.type === 'call').length;
    const arr = [...(campaign.vm_scripts || [])];
    if (arr.length === 0 && campaign.vm_script) arr.push(campaign.vm_script);
    while (arr.length < callCount) arr.push('');
    return arr.slice(0, callCount);
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  function setStep(i, field, v) {
    const next = [...seq]; next[i] = { ...next[i], [field]: v }; setSeq(next);
  }
  function addStep(type) {
    setSeq([...seq, { type, wait_days: 3, active: true, label: type === 'call' ? 'Call' : 'Email' }]);
    if (type === 'call') setVmScripts([...vmScripts, '']);
    else setTemplates([...templates, { subject: '', body: '' }]);
  }
  function removeStep(i) {
    const removed = seq[i];
    setSeq(seq.filter((_, x) => x !== i));
    if (removed?.type === 'call') {
      const callOrdinal = seq.slice(0, i).filter((s) => s?.type === 'call').length;
      setVmScripts(vmScripts.filter((_, x) => x !== callOrdinal));
    } else if (removed?.type === 'email') {
      const emailOrdinal = seq.slice(0, i).filter((s) => s?.type === 'email').length;
      setTemplates(templates.filter((_, x) => x !== emailOrdinal));
    }
  }
  function updateVm(i, v) { const next = [...vmScripts]; next[i] = v; setVmScripts(next); }
  function updateTpl(i, field, v) { const next = [...templates]; next[i] = { ...next[i], [field]: v }; setTemplates(next); }

  async function saveAndLaunch() {
    setBusy(true); setErr(null);
    try {
      const updated = await api.updateCampaign(campaign.id, {
        sequence_config: seq,
        email_templates: templates,
        vm_scripts: vmScripts,
        vm_script: vmScripts[0] || '',
      });
      onCampaignUpdate(updated);
      await onLaunch({ skipEnrichment });
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  }

  let cumulative = 0;
  let callIdx = 0;
  let emailIdx = 0;

  return (
    <div className="content-review">
      <h2>Review Outreach Content</h2>
      <p className="muted">Configure your voicemail script for each call step, then launch.</p>
      {err && <div className="error">{err}</div>}

      <div className="step-editors">
        {seq.map((step, i) => {
          cumulative += step?.wait_days || 0;
          if (step?.type === 'call') {
            const idx = callIdx++;
            return (
              <div key={i} className="step-editor call">
                <div className="step-editor-head">
                  <span className="step-icon">📞</span>
                  <span className="step-editor-title">Step {i + 1}: Call (Day {cumulative})</span>
                  <input type="number" min={0} max={60} value={step.wait_days || 0}
                    onChange={(e) => setStep(i, 'wait_days', parseInt(e.target.value, 10) || 0)}
                    style={{ width: 60 }} title="Days after previous step" />
                  <button className="ghost danger small" onClick={() => removeStep(i)}>×</button>
                </div>
                <label className="field grow">
                  <span>Voicemail script for this call</span>
                  <textarea rows={5} value={vmScripts[idx] || ''} onChange={(e) => updateVm(idx, e.target.value)} />
                </label>
              </div>
            );
          }
          if (step?.type === 'email') {
            const idx = emailIdx++;
            return (
              <div key={i} className="step-editor email">
                <div className="step-editor-head">
                  <span className="step-icon">✉️</span>
                  <span className="step-editor-title">Step {i + 1}: {idx === 0 ? 'Initial email' : `Follow-up #${idx}`} (Day {cumulative})</span>
                  <input type="number" min={0} max={60} value={step.wait_days || 0}
                    onChange={(e) => setStep(i, 'wait_days', parseInt(e.target.value, 10) || 0)}
                    style={{ width: 60 }} title="Days after previous step" />
                  <button className="ghost danger small" onClick={() => removeStep(i)}>×</button>
                </div>
                <label className="field"><span>Subject</span>
                  <input value={templates[idx]?.subject || ''} onChange={(e) => updateTpl(idx, 'subject', e.target.value)} /></label>
                <label className="field grow"><span>Body</span>
                  <textarea rows={6} value={templates[idx]?.body || ''} onChange={(e) => updateTpl(idx, 'body', e.target.value)} /></label>
              </div>
            );
          }
          return null;
        })}
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="ghost" onClick={() => addStep('call')}>+ Add call step</button>
      </div>

      <label className="row" style={{ marginTop: 12, gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={skipEnrichment} onChange={(e) => setSkipEnrichment(e.target.checked)} />
        <span>Test mode: company search only (skip contact enrichment)</span>
      </label>

      <div className="row save-row">
        <button className="primary" disabled={busy || parentBusy} onClick={saveAndLaunch}>
          {busy || parentBusy ? 'Launching…' : skipEnrichment ? 'Save and Launch (companies only)' : 'Save and Launch Campaign'}
        </button>
        <button className="ghost" disabled={busy || parentBusy} onClick={onBack}>Back</button>
      </div>
    </div>
  );
}
