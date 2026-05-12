import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';

const TABS = ['Leads', 'Owners', 'Outreach Content', 'Sequence Builder'];
const ACTIVE_STAGES = ['producers', 'merge', 'apollo_enrich', 'score', 'holistic', 'owners', 'reveal', 'leadmagic', 'sequence'];

const OWNER_STATUSES = ['new', 'emailed', 'called', 'voicemail', 'connected', 'meeting', 'passed'];

export default function CampaignDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [campaign, setCampaign] = useState(null);
  const [tab, setTab] = useState('Leads');
  const [err, setErr] = useState(null);
  const [progress, setProgress] = useState(null);
  const lastLeadCount = useRef(0);

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [id]);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      while (!cancelled) {
        try {
          const p = await api.progress(id);
          if (cancelled) break;
          setProgress(p?.stage ? p : null);
          const leadCount = p?.leadsFound || 0;
          if (leadCount > lastLeadCount.current) {
            lastLeadCount.current = leadCount;
            reload();
          }
          if (!p?.stage || p.stage === 'done' || p.stage === 'error') return;
        } catch {}
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    poll();
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [id]);

  async function reload() {
    try { setCampaign(await api.getCampaign(id)); } catch (e) { setErr(e.message); }
  }

  async function toggleStatus() {
    const next = campaign.status === 'running' ? 'paused' : 'running';
    setCampaign(await api.updateCampaign(id, { status: next }));
  }

  async function deleteCampaign() {
    if (!confirm(`Delete "${campaign.name}"? This deactivates and archives the Apollo sequence and removes all local leads. Cannot be undone.`)) return;
    try {
      await api.deleteCampaign(id);
      nav('/campaigns');
    } catch (e) {
      setErr(e.message);
    }
  }

  const [revealing, setRevealing] = useState(false);
  const [revealMsg, setRevealMsg] = useState(null);
  async function revealAll() {
    const leadCount = (campaign.leads || []).filter((l) => !l.email || !l.phone).length;
    if (!confirm(`Trigger Apollo waterfall reveal for ${leadCount} lead(s) missing email or phone? Each reveal costs ~8 Apollo credits. Results populate via webhook over the next several minutes.`)) return;
    setRevealing(true); setRevealMsg(null);
    try {
      const r = await api.revealContacts(id);
      setRevealMsg(r.message || `Queued ${r.queued}/${r.total}`);
      // Re-poll the campaign after a short delay so any quick-arriving webhooks show.
      setTimeout(reload, 5000);
    } catch (e) {
      setRevealMsg(`Failed: ${e.message}`);
    } finally {
      setRevealing(false);
    }
  }

  if (err) return <div className="error">{err}</div>;
  if (!campaign) return <div className="loading">Loading…</div>;

  return (
    <div>
      <div className="detail-head">
        <div className="detail-head-left">
          <Link to="/campaigns" className="muted small">← Campaigns</Link>
          <h1>
            <span className={`status-dot status-${campaign.status}`} />
            {campaign.name}
          </h1>
          <p className="muted clamp-3">{campaign.prompt}</p>
          <CampaignMeta campaign={campaign} />
        </div>
        <div className="row">
          <button onClick={toggleStatus}>{campaign.status === 'running' ? 'Pause' : 'Resume'}</button>
          <button onClick={revealAll} disabled={revealing}>{revealing ? 'Revealing…' : 'Reveal contacts'}</button>
          <button className="primary" onClick={() => nav(`/campaigns/${id}/dial`)}>Start Dialing</button>
          <button className="danger" onClick={deleteCampaign}>Delete</button>
        </div>
      </div>

      {progress && <ProgressBanner progress={progress} />}
      {revealMsg && <div className="muted small" style={{ padding: '8px 0' }}>📡 {revealMsg}</div>}

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      {tab === 'Leads' && <LeadsTab campaign={campaign} reload={reload} />}
      {tab === 'Owners' && <OwnersTab campaignId={id} sequenceConfig={campaign.sequence_config || []} />}
      {tab === 'Outreach Content' && <OutreachTab campaign={campaign} reload={reload} />}
      {tab === 'Sequence Builder' && <SequenceTab campaign={campaign} reload={reload} />}
    </div>
  );
}

function CampaignMeta({ campaign }) {
  const target = campaign.target_lead_count ?? 150;
  const minScore = campaign.min_priority_score ?? 50;
  const maxBatches = campaign.max_search_batches ?? 4;
  const apolloId = campaign.apollo_sequence_id;
  const apolloUrl = apolloId ? `https://app.apollo.io/#/emailer_campaigns/${apolloId}` : null;
  return (
    <div className="meta-row">
      <span className="meta-chip">Target: <b>{target}</b></span>
      <span className="meta-chip">Min score: <b>{minScore}</b></span>
      <span className="meta-chip">Max batches: <b>{maxBatches}</b></span>
      {apolloId ? (
        <a href={apolloUrl} target="_blank" rel="noreferrer" className="meta-chip apollo-on">
          Apollo: <b>{apolloId.slice(0, 8)}…</b> ↗
        </a>
      ) : (
        <span className="meta-chip apollo-off">Apollo: not synced</span>
      )}
    </div>
  );
}

function LockBanner() {
  return (
    <div className="lock-banner">
      🔒 <b>Locked after launch.</b> Apollo holds the source of truth for this campaign's sequence and templates.
      To use different templates, create a new campaign.
    </div>
  );
}

function ProgressBanner({ progress }) {
  const STAGE_ORDER = ['producers', 'merge', 'apollo_enrich', 'score', 'holistic', 'owners', 'reveal', 'leadmagic', 'sequence', 'done'];
  const STAGE_LABELS = {
    producers: 'Running producers (Exa / Apollo / CSV)',
    merge: 'Merging companies',
    apollo_enrich: 'Apollo firmographics',
    score: 'Scoring companies',
    holistic: 'Holistic Claude profile',
    owners: 'Discovering owners',
    reveal: 'Apollo contact reveal',
    leadmagic: 'LeadMagic auto-fallback',
    sequence: 'Creating Apollo sequence',
    done: 'Done',
    error: 'Failed',
  };
  const idx = STAGE_ORDER.indexOf(progress.stage);
  const isError = progress.stage === 'error';
  const isDone = progress.stage === 'done';
  const isActive = ACTIVE_STAGES.includes(progress.stage);
  const stageNum = isError ? '—' : Math.max(idx, 0) + 1;
  const totalStages = STAGE_ORDER.length - 1;

  const pct = progress.total
    ? Math.min(100, Math.round((progress.current || 0) / progress.total * 100))
    : isDone ? 100 : 0;

  return (
    <div className={`progress-banner ${isError ? 'error' : isDone ? 'done' : 'active'}`}>
      <div className="progress-head">
        <div>
          <b>
            {isError ? 'Pipeline failed' : `${STAGE_LABELS[progress.stage] || progress.stage} (${stageNum}/${totalStages})`}
          </b>
          <span className="muted small">
            {progress.total ? `  ${progress.current || 0} / ${progress.total}` : ''}
            {progress.leadsFound ? `  ·  ${progress.leadsFound} leads added` : ''}
          </span>
        </div>
        {isActive && <span className="spinner" />}
      </div>
      {progress.message && <div className="muted small">{progress.message}</div>}
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      {progress.errors?.length > 0 && (
        <div className="progress-errors">
          {progress.errors.map((e, i) => <div key={i} className="error-line">⚠ {e}</div>)}
        </div>
      )}
    </div>
  );
}

function LeadsTab({ campaign, reload }) {
  const [expanded, setExpanded] = useState(null);
  const [editingScore, setEditingScore] = useState(null);
  const [scoreVal, setScoreVal] = useState('');
  const [sortBy, setSortBy] = useState('priority_score');
  const [sortDir, setSortDir] = useState('desc');

  const visibleLeads = (campaign.leads || []).filter((l) => l.pass_fail !== 'FAIL');
  const leads = [...visibleLeads].sort((a, b) => {
    const av = a[sortBy] ?? '';
    const bv = b[sortBy] ?? '';
    const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  function toggleSort(col) {
    if (sortBy === col) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('desc'); }
  }

  async function commitScore(lead) {
    const v = parseInt(scoreVal, 10);
    setEditingScore(null);
    if (Number.isNaN(v) || v === lead.priority_score) return;
    await api.updateLead(lead.id, { priority_score: Math.max(0, Math.min(100, v)) });
    reload();
  }

  function startEditScore(lead) {
    setEditingScore(lead.id);
    setScoreVal(String(lead.priority_score ?? 0));
  }

  async function remove(lead) {
    if (!confirm(`Remove ${lead.company_name || 'this lead'}?`)) return;
    await api.deleteLead(lead.id);
    reload();
  }

  if (!leads.length) {
    return (
      <div className="empty">
        <p>No leads yet.</p>
        <p className="muted small">If a pipeline is running, leads will populate as research completes. Otherwise, check the progress banner above for any errors.</p>
      </div>
    );
  }

  function caret(col) {
    if (sortBy !== col) return null;
    return <span className="caret">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  return (
    <div className="leads-wrap">
      <table className="leads">
        <thead>
          <tr>
            <th onClick={() => toggleSort('priority_score')} className="sortable col-score">Score{caret('priority_score')}</th>
            <th onClick={() => toggleSort('company_name')} className="sortable">Company{caret('company_name')}</th>
            <th>Contact</th>
            <th onClick={() => toggleSort('revenue')} className="sortable">Revenue{caret('revenue')}</th>
            <th>EBITDA</th>
            <th onClick={() => toggleSort('location')} className="sortable">Location{caret('location')}</th>
            <th onClick={() => toggleSort('status')} className="sortable col-status">Status{caret('status')}</th>
            <th>Last Action</th>
            <th className="col-actions"></th>
          </tr>
        </thead>
        <tbody>
          {leads.map((l) => (
            <Fragment key={l.id}>
              <tr className="lead-row">
                <td className="col-score">
                  {editingScore === l.id ? (
                    <input
                      type="number" min={0} max={100} autoFocus
                      value={scoreVal}
                      onChange={(e) => setScoreVal(e.target.value)}
                      onBlur={() => commitScore(l)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitScore(l);
                        if (e.key === 'Escape') setEditingScore(null);
                      }}
                      className="score-input"
                    />
                  ) : (
                    <button className="score-pill" onClick={() => startEditScore(l)} title="Click to edit">
                      {l.priority_score ?? 0}
                    </button>
                  )}
                </td>
                <td>
                  <div className="company-cell">
                    <span className="company-name">{l.company_name || '(unnamed)'}</span>
                    {l.company_url && (
                      <a href={l.company_url} target="_blank" rel="noreferrer" className="muted small ext">
                        {hostname(l.company_url)}
                      </a>
                    )}
                  </div>
                </td>
                <td>
                  <div>{l.contact_name || <span className="muted">—</span>}</div>
                  <div className="muted small">{l.contact_title || ''}</div>
                </td>
                <td>{l.revenue || <span className="muted">—</span>}</td>
                <td>{l.ebitda || <span className="muted">—</span>}</td>
                <td>{l.location || <span className="muted">—</span>}</td>
                <td className="col-status"><span className={`badge badge-${l.status}`}>{l.status}</span></td>
                <td>
                  <div className="small">{prettyAction(l.last_action)}</div>
                  <div className="muted small">{l.last_action_date ? new Date(l.last_action_date).toLocaleDateString() : ''}</div>
                </td>
                <td className="col-actions">
                  <button className="ghost small" onClick={() => setExpanded(expanded === l.id ? null : l.id)}>
                    {expanded === l.id ? 'Hide' : 'More'}
                  </button>
                  <button className="ghost danger small" title="Remove" onClick={() => remove(l)}>×</button>
                </td>
              </tr>
              {expanded === l.id && (
                <tr className="expanded-row">
                  <td colSpan={9}>
                    <ProfileExpanded lead={l} reload={reload} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProfileExpanded({ lead: l, reload }) {
  const fundingChip = l.total_funding
    ? `Funding: $${(l.total_funding / 1e6).toFixed(1)}M${l.latest_funding_round_date ? ' · ' + l.latest_funding_round_date : ''}`
    : (l.latest_funding_round_date ? `Last round: ${l.latest_funding_round_date}` : null);
  const socialLinks = [
    l.linkedin_url && { href: l.linkedin_url, label: 'LinkedIn' },
    l.twitter_url && { href: l.twitter_url, label: 'Twitter' },
    l.facebook_url && { href: l.facebook_url, label: 'Facebook' },
  ].filter(Boolean);
  return (
    <div className="profile">
      <div className="profile-row">
        {l.industry && <span className="chip">{l.industry}</span>}
        {l.vertical_signal && <span className="chip muted">{l.vertical_signal}</span>}
        {l.ownership && <span className="chip muted">{l.ownership}</span>}
        {l.employees ? <span className="chip muted">{l.employees} emp</span> : null}
        {l.founded_year ? <span className="chip muted">Founded {l.founded_year}</span> : null}
        {l.annual_revenue_printed && <span className="chip muted">{l.annual_revenue_printed}</span>}
        {fundingChip && <span className="chip muted">{fundingChip}</span>}
        {l.parent_company && (
          <span className="chip warn" title="This company has a parent — may be rolled up">
            ⚠ Parent: {l.parent_company}
          </span>
        )}
      </div>
      {l.short_description && (
        <p className="muted" style={{ fontStyle: 'italic' }}>{l.short_description}</p>
      )}
      {(socialLinks.length > 0 || (l.naics_codes?.length > 0) || (l.sic_codes?.length > 0)) && (
        <div className="profile-row" style={{ gap: 8 }}>
          {socialLinks.map((s) => (
            <a key={s.label} href={s.href} target="_blank" rel="noreferrer" className="ext-link">🔗 {s.label}</a>
          ))}
          {l.naics_codes?.length > 0 && <span className="muted small">NAICS: {l.naics_codes.join(', ')}</span>}
          {l.sic_codes?.length > 0 && <span className="muted small">SIC: {l.sic_codes.join(', ')}</span>}
        </div>
      )}
      {Array.isArray(l.keywords) && l.keywords.length > 0 && (
        <div className="profile-row">
          {l.keywords.slice(0, 20).map((k, i) => <span key={i} className="chip muted">{k}</span>)}
        </div>
      )}
      {Array.isArray(l.technologies) && l.technologies.length > 0 && (
        <details>
          <summary className="muted small">{l.technologies.length} technologies</summary>
          <div className="profile-row" style={{ marginTop: 4 }}>
            {l.technologies.map((t, i) => <span key={i} className="chip muted">{t}</span>)}
          </div>
        </details>
      )}
      <Owner lead={l} reload={reload} />
      <TeamMembers leadId={l.id} />
      <h4>Description</h4><p>{l.description || <span className="muted">—</span>}</p>
      <h4>Fit Rationale</h4><p>{l.fit_rationale || <span className="muted">—</span>}</p>
      {l.flags && l.flags !== 'None identified' && (<><h4>Flags</h4><p className="warn">{l.flags}</p></>)}
      {l.bio_json && <Bio bio={l.bio_json} />}
    </div>
  );
}

function Owner({ lead: l, reload }) {
  // Prefer the new lead_owners join. Falls back to legacy contacts[] / direct
  // lead fields for rows that haven't been re-enriched through the new
  // pipeline yet.
  const owners = Array.isArray(l.owners) && l.owners.length
    ? l.owners
    : null;

  if (owners) {
    const primary = pickPrimary(owners);
    return (
      <>
        <h4>Owners ({owners.length})</h4>
        <div className="owners-list">
          {owners.map((o) => (
            <OwnerCard
              key={o.id}
              contact={{
                name: o.name,
                title: o.title,
                email: o.email,
                phone: o.phone,
                linkedin_url: o.linkedin_url,
                source: (o.sources && o.sources[0]) || o.enrichment_source,
                email_status: o.email_status,
                phone_status: o.phone_status,
                confidence: o.confidence,
              }}
              isPrimary={o.id === primary?.id}
              onMakePrimary={null}
            />
          ))}
        </div>
      </>
    );
  }

  // Legacy fallback (old leads.contacts[] or just direct mirror fields).
  const contacts = Array.isArray(l.contacts) ? l.contacts : [];
  const primaryIdx = l.primary_contact_idx ?? 0;
  if (!contacts.length) {
    const has = l.contact_name || l.email || l.phone || l.contact_title;
    return (
      <>
        <h4>Owners</h4>
        {has ? (
          <div className="owners-list">
            <OwnerCard
              contact={{ name: l.contact_name, title: l.contact_title, email: l.email, phone: l.phone, source: 'apollo' }}
              isPrimary={true}
              onMakePrimary={null}
            />
          </div>
        ) : (
          <p className="muted">No owner contact found. Re-run the rediscover-owners script or check the website manually.</p>
        )}
      </>
    );
  }
  async function makePrimary(idx) {
    if (idx === primaryIdx) return;
    const primary = contacts[idx];
    await api.updateLead(l.id, {
      primary_contact_idx: idx,
      contact_name: primary.name || null,
      contact_title: primary.title || null,
      email: primary.email || null,
      phone: primary.phone || null,
    });
    if (reload) await reload();
  }
  return (
    <>
      <h4>Owners ({contacts.length})</h4>
      <div className="owners-list">
        {contacts.map((c, i) => (
          <OwnerCard
            key={i}
            contact={c}
            isPrimary={i === primaryIdx}
            onMakePrimary={() => makePrimary(i)}
          />
        ))}
      </div>
    </>
  );
}

function pickPrimary(owners) {
  // First owner with email+phone, then with email, then first row.
  const byEmailPhone = owners.find((o) => o.email && o.phone);
  if (byEmailPhone) return byEmailPhone;
  const byEmail = owners.find((o) => o.email);
  if (byEmail) return byEmail;
  return owners[0];
}

function OwnerCard({ contact: c, isPrimary, onMakePrimary }) {
  return (
    <div className={`owner-card ${isPrimary ? 'primary' : ''}`}>
      <div className="owner-card-head">
        <span className="owner-name">{c.name || '(no name)'}</span>
        {isPrimary && <span className="badge-primary">Primary</span>}
        {c.source && <span className="muted small">via {c.source}</span>}
        {c.confidence && <span className="muted small">· {c.confidence}</span>}
      </div>
      {c.title && <div className="muted small">{c.title}</div>}
      <div className="owner-card-row">
        {c.email && (
          <a href={`mailto:${c.email}`} className="ext-link">
            📧 {c.email}
            {c.email_status && <span className="muted small"> ({c.email_status})</span>}
          </a>
        )}
        {c.phone && (
          <a href={`tel:${c.phone}`} className="ext-link">
            📞 {c.phone}
            {c.phone_status && <span className="muted small"> ({c.phone_status})</span>}
          </a>
        )}
        {c.linkedin_url && <a href={c.linkedin_url} target="_blank" rel="noreferrer" className="ext-link">🔗 LinkedIn</a>}
      </div>
      {!isPrimary && onMakePrimary && (
        <button className="ghost small" onClick={onMakePrimary}>Make primary</button>
      )}
    </div>
  );
}

function TeamMembers({ leadId }) {
  // Lazy-load the broader employee list from Apollo on first expand. Doesn't
  // touch our DB — just informational context for the user. Filters out anyone
  // already in the Owners section (matched by apollo_contact_id).
  const [team, setTeam] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  async function load() {
    if (loading || team) return;
    setLoading(true); setErr(null);
    try {
      const { team: t, error } = await api.leadTeam(leadId);
      if (error) setErr(error);
      setTeam(t || []);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h4>Key Team Members</h4>
      {!team && (
        <button className="ghost small" disabled={loading} onClick={load}>
          {loading ? 'Loading…' : 'Load from Apollo'}
        </button>
      )}
      {err && <div className="muted small warn">⚠ {err}</div>}
      {team && team.length === 0 && <p className="muted">No team data in Apollo for this domain.</p>}
      {team && team.length > 0 && (
        <table className="team-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Title</th>
              <th>LinkedIn</th>
            </tr>
          </thead>
          <tbody>
            {team.map((m) => (
              <tr key={m.apollo_contact_id}>
                <td>{m.name || '—'}</td>
                <td>{m.title || <span className="muted">—</span>}</td>
                <td>{m.linkedin_url ? <a href={m.linkedin_url} target="_blank" rel="noreferrer">↗</a> : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Bio({ bio }) {
  return (
    <div className="bio-grid">
      {bio.ice_breakers?.length > 0 && (
        <div>
          <h4>Ice Breakers</h4>
          <ul>{bio.ice_breakers.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </div>
      )}
      {bio.industry_news?.length > 0 && (
        <div>
          <h4>Industry News</h4>
          <ul>{bio.industry_news.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </div>
      )}
      {bio.talking_points?.length > 0 && (
        <div>
          <h4>Talking Points</h4>
          <ul>{bio.talking_points.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function OwnersTab({ campaignId, sequenceConfig }) {
  const [owners, setOwners] = useState(null);
  const [err, setErr] = useState(null);
  const [sortBy, setSortBy] = useState('priority_score');
  const [sortDir, setSortDir] = useState('desc');

  async function load() {
    try {
      const r = await api.listLeadOwners(campaignId);
      setOwners(r.owners || []);
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [campaignId]);

  function toggleSort(col) {
    if (sortBy === col) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('desc'); }
  }
  function caret(col) {
    if (sortBy !== col) return null;
    return <span className="caret">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  async function patchOwner(id, patch) {
    try {
      const updated = await api.updateLeadOwner(id, patch);
      setOwners((cur) => cur.map((o) => (o.id === id ? { ...o, ...updated } : o)));
    } catch (e) {
      alert(`Update failed: ${e.message}`);
    }
  }
  async function removeOwner(o) {
    if (!confirm(`Remove ${o.name || 'this owner'} from ${o.company_name || 'this company'}?`)) return;
    try {
      await api.deleteLeadOwner(o.id);
      setOwners((cur) => cur.filter((x) => x.id !== o.id));
    } catch (e) { alert(`Delete failed: ${e.message}`); }
  }

  if (err) return <div className="error">{err}</div>;
  if (!owners) return <div className="loading">Loading owners…</div>;
  if (!owners.length) {
    return (
      <div className="empty">
        <p>No owners discovered yet.</p>
        <p className="muted small">Owner discovery runs during launch for leads scoring above 50. If the pipeline finished without discovering owners, try the rediscover-owners script.</p>
      </div>
    );
  }

  const sorted = [...owners].sort((a, b) => {
    const av = a[sortBy] ?? '';
    const bv = b[sortBy] ?? '';
    const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const stepLabel = (idx) => {
    const s = sequenceConfig[idx];
    if (!s) return `Step ${idx + 1}`;
    return `${idx + 1}. ${s.label || s.type}`;
  };

  return (
    <div className="leads-wrap">
      <table className="leads">
        <thead>
          <tr>
            <th onClick={() => toggleSort('priority_score')} className="sortable col-score">Score{caret('priority_score')}</th>
            <th onClick={() => toggleSort('company_name')} className="sortable">Company{caret('company_name')}</th>
            <th onClick={() => toggleSort('name')} className="sortable">Owner{caret('name')}</th>
            <th>Title</th>
            <th>Email</th>
            <th>Phone</th>
            <th onClick={() => toggleSort('sequence_step')} className="sortable">Step{caret('sequence_step')}</th>
            <th onClick={() => toggleSort('status')} className="sortable col-status">Status{caret('status')}</th>
            <th>Last Action</th>
            <th>Override</th>
            <th className="col-actions"></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((o) => (
            <tr key={o.id} className="lead-row">
              <td className="col-score">{o.priority_score ?? 0}</td>
              <td>
                <div className="company-cell">
                  <span className="company-name">{o.company_name || '(unnamed)'}</span>
                  {o.company_url && (
                    <a href={o.company_url} target="_blank" rel="noreferrer" className="muted small ext">
                      {hostname(o.company_url)}
                    </a>
                  )}
                </div>
              </td>
              <td>
                <div>{o.name || <span className="muted">—</span>}</div>
                {(o.sources && o.sources.length > 0) && (
                  <div className="muted small">via {o.sources.join(', ')}</div>
                )}
              </td>
              <td><div className="muted small">{o.title || ''}</div></td>
              <td>
                {o.email ? (
                  <a href={`mailto:${o.email}`} className="ext-link small">{o.email}</a>
                ) : <span className="muted">—</span>}
                {o.email_status && <div className="muted small">({o.email_status})</div>}
              </td>
              <td>
                {o.phone ? (
                  <a href={`tel:${o.phone}`} className="ext-link small">{o.phone}</a>
                ) : <span className="muted">—</span>}
                {o.phone_status && <div className="muted small">({o.phone_status})</div>}
              </td>
              <td>
                <select
                  value={o.sequence_step ?? 0}
                  onChange={(e) => patchOwner(o.id, { sequence_step: parseInt(e.target.value, 10) })}
                  className="step-select"
                >
                  {sequenceConfig.map((_, i) => (
                    <option key={i} value={i}>{stepLabel(i)}</option>
                  ))}
                  <option value={sequenceConfig.length}>Complete</option>
                </select>
              </td>
              <td className="col-status">
                <select
                  value={o.status || 'new'}
                  onChange={(e) => patchOwner(o.id, { status: e.target.value })}
                  className={`badge badge-${o.status || 'new'}`}
                >
                  {OWNER_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </td>
              <td>
                <div className="small">{prettyAction(o.last_action)}</div>
                <div className="muted small">{o.last_action_date ? new Date(o.last_action_date).toLocaleDateString() : ''}</div>
              </td>
              <td>
                {o.stage_overridden_at ? (
                  <span className="badge-primary" title={`Manually overridden ${new Date(o.stage_overridden_at).toLocaleString()}`}>
                    ✋ overridden
                  </span>
                ) : <span className="muted small">auto</span>}
              </td>
              <td className="col-actions">
                <button className="ghost danger small" title="Remove owner" onClick={() => removeOwner(o)}>×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OutreachTab({ campaign, reload }) {
  // Mirrors sequence_config 1:1 — N call steps → N vm_scripts editors,
  // M email steps → M template editors. Backfills vm_scripts[0] from
  // legacy single vm_script for old campaigns.
  const seq = campaign.sequence_config || [];
  const callCount = seq.filter((s) => s?.type === 'call').length;
  const emailCount = seq.filter((s) => s?.type === 'email').length;

  const initialVmScripts = (() => {
    const arr = [...(campaign.vm_scripts || [])];
    if (arr.length === 0 && campaign.vm_script) arr.push(campaign.vm_script);
    while (arr.length < callCount) arr.push('');
    return arr.slice(0, callCount);
  })();

  const initialTemplates = (() => {
    const arr = [...(campaign.email_templates || [])];
    while (arr.length < emailCount) arr.push({ subject: '', body: '' });
    return arr.slice(0, emailCount);
  })();

  const [templates, setTemplates] = useState(initialTemplates);
  const [vmScripts, setVmScripts] = useState(initialVmScripts);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const locked = !!campaign.locked_at;

  function updateTpl(i, field, v) {
    const next = [...templates];
    next[i] = { ...next[i], [field]: v };
    setTemplates(next);
    setSaved(false);
  }

  function updateVm(i, v) {
    const next = [...vmScripts];
    next[i] = v;
    setVmScripts(next);
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    try {
      await api.updateCampaign(campaign.id, {
        email_templates: templates,
        vm_scripts: vmScripts,
        // Keep singular vm_script in sync with vm_scripts[0] for backwards-compat readers.
        vm_script: vmScripts[0] || '',
      });
      setSaved(true);
      reload();
    } finally {
      setBusy(false);
    }
  }

  // Walk sequence_config and group steps by type for ordered rendering.
  // Each call step gets its own vm_scripts editor; each email gets its own template.
  let callIdx = 0;
  let emailIdx = 0;
  const stepEditors = seq.map((step, stepNum) => {
    if (step?.type === 'call') {
      const idx = callIdx++;
      return {
        kind: 'call',
        stepNum,
        idx,
        label: step.label || `Voicemail ${idx + 1}`,
        waitDays: step.wait_days || 0,
      };
    }
    if (step?.type === 'email') {
      const idx = emailIdx++;
      return {
        kind: 'email',
        stepNum,
        idx,
        label: step.label || (idx === 0 ? 'Initial email' : `Follow-up ${idx}`),
        waitDays: step.wait_days || 0,
      };
    }
    return null;
  }).filter(Boolean);

  if (seq.length === 0) {
    return (
      <div className="outreach">
        <div className="empty">
          <p>No sequence steps yet. Add steps in the Sequence Builder tab — content editors for each step will appear here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="outreach">
      {locked && <LockBanner />}
      <div className="section-head">
        <h2>Outreach Content</h2>
        <span className="muted small">
          One editor per sequence step ({callCount} call{callCount === 1 ? '' : 's'}, {emailCount} email{emailCount === 1 ? '' : 's'}). Variables: [FIRST_NAME], [COMPANY], [INDUSTRY], [SENDER]
        </span>
      </div>

      <div className="step-editors">
        {stepEditors.map((s) => (
          <div key={s.stepNum} className={`step-editor ${s.kind} ${locked ? 'locked' : ''}`}>
            <div className="step-editor-head">
              <span className="step-icon">{s.kind === 'call' ? '📞' : '✉️'}</span>
              <span className="step-editor-title">Step {s.stepNum + 1}: {s.label}</span>
              <span className="muted small">wait {s.waitDays}d</span>
            </div>
            {s.kind === 'call' ? (
              <label className="field grow">
                <span>Voicemail script</span>
                <textarea
                  rows={5}
                  value={vmScripts[s.idx] || ''}
                  onChange={(e) => updateVm(s.idx, e.target.value)}
                  placeholder="Hi [FIRST_NAME], I'm calling because…"
                  disabled={locked}
                />
              </label>
            ) : (
              <>
                <label className="field">
                  <span>Subject</span>
                  <input
                    value={templates[s.idx]?.subject || ''}
                    onChange={(e) => updateTpl(s.idx, 'subject', e.target.value)}
                    placeholder="Subject"
                    disabled={locked}
                  />
                </label>
                <label className="field grow">
                  <span>Body</span>
                  <textarea
                    rows={8}
                    value={templates[s.idx]?.body || ''}
                    onChange={(e) => updateTpl(s.idx, 'body', e.target.value)}
                    placeholder="Body"
                    disabled={locked}
                  />
                </label>
              </>
            )}
          </div>
        ))}
      </div>

      {!locked && (
        <div className="row save-row">
          <button className="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
          {saved && <span className="muted small">Saved</span>}
        </div>
      )}
    </div>
  );
}

function SequenceTab({ campaign, reload }) {
  const [steps, setSteps] = useState(campaign.sequence_config || []);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const locked = !!campaign.locked_at;

  function update(i, field, v) {
    if (locked) return;
    const next = [...steps];
    next[i] = { ...next[i], [field]: v };
    setSteps(next);
    setSaved(false);
  }

  function addStep() {
    if (locked) return;
    setSteps([...steps, { type: 'email', wait_days: 3, active: true, label: 'New step' }]);
    setSaved(false);
  }
  function removeStep(i) { if (locked) return; setSteps(steps.filter((_, idx) => idx !== i)); setSaved(false); }

  async function save() {
    setBusy(true);
    try {
      await api.updateCampaign(campaign.id, { sequence_config: steps });
      setSaved(true);
      reload();
    } finally {
      setBusy(false);
    }
  }

  // Cumulative day from campaign start (sum of wait_days up to and including step i)
  let cumulative = 0;

  return (
    <div className="sequence">
      {locked && <LockBanner />}
      <div className="section-head">
        <h2>Outreach Sequence</h2>
        <span className="muted small">Steps run in order; "Wait" is days since the previous step</span>
      </div>
      <div className="step-list">
        {steps.map((s, i) => {
          cumulative += (s.wait_days || 0);
          const dayLabel = `Day ${cumulative}`;
          const isCall = s.type === 'call';
          return (
            <div key={i} className={`step-card ${s.active ? '' : 'inactive'} ${isCall ? 'step-call' : 'step-email'} ${locked ? 'locked' : ''}`}>
              <div className="step-num">{i + 1}</div>
              <div className="step-day">{dayLabel}</div>
              <div className="step-type-pill">
                <span className="step-icon">{isCall ? '📞' : '✉️'}</span>
                <span>{isCall ? 'Call + VM' : 'Email'}</span>
              </div>
              <select value={s.type} onChange={(e) => update(i, 'type', e.target.value)} className="step-select" disabled={locked}>
                <option value="email">Email</option>
                <option value="call">Call + VM</option>
              </select>
              <label className="step-wait">
                <span>Wait</span>
                <input type="number" min={0} value={s.wait_days || 0}
                  onChange={(e) => update(i, 'wait_days', parseInt(e.target.value, 10) || 0)} disabled={locked} />
                <span>days</span>
              </label>
              <input className="step-label" value={s.label || ''}
                onChange={(e) => update(i, 'label', e.target.value)} placeholder="Label" disabled={locked} />
              <label className="toggle">
                <input type="checkbox" checked={!!s.active} onChange={(e) => update(i, 'active', e.target.checked)} disabled={locked} />
                <span>{s.active ? 'On' : 'Off'}</span>
              </label>
              {!locked && <button className="ghost danger small" title="Remove" onClick={() => removeStep(i)}>×</button>}
            </div>
          );
        })}
      </div>
      {!locked && (
        <div className="row save-row">
          <button className="ghost" onClick={addStep}>+ Add step</button>
          <button className="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save sequence'}</button>
          {saved && <span className="muted small">Saved</span>}
        </div>
      )}
    </div>
  );
}

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}
function prettyAction(a) {
  if (!a) return '—';
  return a.replace(/_/g, ' ');
}
