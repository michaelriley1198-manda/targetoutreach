import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

export default function CampaignList() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.listCampaigns()
      .then(setCampaigns)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading">Loading…</div>;
  if (err) return <div className="error">Error: {err}</div>;

  return (
    <div>
      <div className="section-head">
        <h1>Campaigns</h1>
        <Link to="/campaigns/new" className="btn-link primary">+ New Campaign</Link>
      </div>
      {!campaigns.length && (
        <div className="empty">
          <p>No campaigns yet.</p>
          <Link to="/campaigns/new">Create your first campaign →</Link>
        </div>
      )}
      <div className="grid">
        {campaigns.map((c) => (
          <Link key={c.id} to={`/campaigns/${c.id}`} className="card campaign-card">
            <div className="card-head">
              <div className="card-title">
                <span className={`status-dot status-${c.status}`} />
                <h3>{c.name}</h3>
              </div>
              <span className={`badge badge-${c.status}`}>{c.status}</span>
            </div>
            <p className="muted clamp-3">{c.prompt}</p>
            <div className="stats">
              <div><b>{c.stats.leads}</b><span>leads</span></div>
              <div><b>{c.stats.reached}</b><span>reached</span></div>
              <div><b>{c.stats.connected}</b><span>connected</span></div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
