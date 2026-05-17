import express from 'express';
import { supabase } from '../db.js';
import { parseContacts } from '../services/signalhire.js';

export const signalhireRouter = express.Router();

// Signal Hire async enrichment webhook.
// Payload: [{ item, status, candidate: { contacts: [{ type, value, subType }] } }]
// We match the owner by linkedin_url or email (whichever was used as the item),
// then write phone (and email if missing) without overwriting existing values.
signalhireRouter.post('/webhook', async (req, res) => {
  res.json({ ok: true });

  try {
    const results = Array.isArray(req.body) ? req.body : [req.body];
    for (const result of results) {
      if (result.status !== 'success' || !result.candidate) continue;

      const item = result.item;
      const { phone, email } = parseContacts(result.candidate.contacts || []);
      if (!phone && !email) continue;

      // Normalize LinkedIn URLs (http→https, trailing slash) for matching.
      function normalizeLinkedin(url) {
        return (url || '').replace(/^http:\/\//, 'https://').replace(/\/$/, '').toLowerCase();
      }

      // Match all owners sharing this identifier (same LinkedIn URL or email),
      // including http/https variants of the same profile.
      let owners = [];
      if (item?.includes('linkedin.com')) {
        const norm = normalizeLinkedin(item);
        const { data } = await supabase
          .from('lead_owners')
          .select('id, email, phone, linkedin_url');
        owners = (data || []).filter((o) => normalizeLinkedin(o.linkedin_url) === norm);
      } else if (item) {
        const { data } = await supabase
          .from('lead_owners')
          .select('id, email, phone')
          .eq('email', item);
        owners = data || [];
      }

      if (!owners.length) {
        console.warn('[signalhire/webhook] no owner matched for item:', item);
        continue;
      }

      for (const owner of owners) {
        const patch = {};
        if (phone && !owner.phone) { patch.phone = phone; patch.phone_status = 'verified'; }
        if (email && !owner.email) { patch.email = email; }
        if (!Object.keys(patch).length) continue;
        patch.enrichment_source = 'signalhire';

        const { error } = await supabase.from('lead_owners').update(patch).eq('id', owner.id);
        if (error) console.warn('[signalhire/webhook] DB update failed', owner.id, error.message);
        else console.log(`[signalhire/webhook] updated owner ${owner.id}:`, Object.keys(patch).join('+'));
      }
    }
  } catch (e) {
    console.warn('[signalhire/webhook] handler threw', e.message);
  }
});
