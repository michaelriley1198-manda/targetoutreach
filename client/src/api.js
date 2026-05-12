async function req(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

async function upload(path, file, extraFields = {}) {
  const fd = new FormData();
  fd.append('file', file);
  for (const [k, v] of Object.entries(extraFields)) fd.append(k, v);
  const res = await fetch(path, { method: 'POST', body: fd });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export const api = {
  listCampaigns: () => req('/api/campaigns'),
  getCampaign: (id) => req(`/api/campaigns/${id}`),
  createCampaign: (body) => req('/api/campaigns', { method: 'POST', body }),
  updateCampaign: (id, body) => req(`/api/campaigns/${id}`, { method: 'PATCH', body }),
  deleteCampaign: (id) => req(`/api/campaigns/${id}`, { method: 'DELETE' }),
  generatePrompts: (id) => req(`/api/campaigns/${id}/generate-prompts`, { method: 'POST' }),
  launch: (id, queries, opts = {}) => req(`/api/campaigns/${id}/launch`, {
    method: 'POST',
    body: {
      queries,
      skip_enrichment: !!opts.skipEnrichment,
      csv_staging_id: opts.csvStagingId || null,
    },
  }),
  progress: (id) => req(`/api/campaigns/${id}/progress`),
  callQueue: (id) => req(`/api/campaigns/${id}/call-queue`),
  dial: (id, leadIds) => req(`/api/campaigns/${id}/dial`, { method: 'POST', body: { lead_ids: leadIds } }),
  updateLead: (id, body) => req(`/api/leads/${id}`, { method: 'PATCH', body }),
  deleteLead: (id) => req(`/api/leads/${id}`, { method: 'DELETE' }),
  leadBio: (id) => req(`/api/leads/${id}/bio`),
  leadTeam: (id) => req(`/api/leads/${id}/team`),
  revealContacts: (id) => req(`/api/campaigns/${id}/reveal-contacts`, { method: 'POST' }),

  // Multi-source acquisition
  listApolloLabels: () => req('/api/sources/apollo-labels'),
  previewApolloFilters: (prompt) => req('/api/sources/apollo-filters/preview', { method: 'POST', body: { prompt } }),
  previewApolloSearch: (filters, per_page = 25) => req('/api/sources/apollo-search/preview', { method: 'POST', body: { filters, per_page } }),
  uploadCsvPreview: (file) => upload('/api/sources/csv/preview', file),

  // Owners (per-contact, with per-owner campaign stage tracking)
  listLeadOwners: (campaignId) => req(`/api/lead-owners/by-campaign/${campaignId}`),
  updateLeadOwner: (id, body) => req(`/api/lead-owners/${id}`, { method: 'PATCH', body }),
  deleteLeadOwner: (id) => req(`/api/lead-owners/${id}`, { method: 'DELETE' }),

  // Browser WebRTC dialer (Wave 4)
  getTwilioToken: () => req('/api/twilio/token'),
  logCallOutcome: (callSid, body) => req(`/api/campaigns/call-logs/${callSid}/outcome`, { method: 'PATCH', body }),
  dialSessionEvents: (sessionId) => new EventSource(`/api/twilio/dial-session/${sessionId}/events`),
};
