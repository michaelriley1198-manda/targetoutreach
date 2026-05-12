import express from 'express';
import { supabase } from '../db.js';

export const apolloRouter = express.Router();

// Apollo's async enrichment webhook delivery target.
// Called when run_waterfall_email / run_waterfall_phone completes for a
// previously matched person. Payload shape (per Apollo docs):
//   {
//     "status": "success",
//     "people": [
//       {
//         "id": "<apollo_contact_id>",
//         "status": "success",
//         "email": "...",                // sometimes top-level
//         "personal_emails": [...],      // for waterfall email reveal
//         "phone_numbers": [{ sanitized_number, raw_number, ... }],
//       }
//     ]
//   }
//
// We look up the lead by apollo_contact_id and patch in any newly-revealed
// email + phone, leaving other fields alone. Idempotent — can be called
// multiple times safely.
apolloRouter.post('/enrichment-webhook', async (req, res) => {
  // Always 200 fast — Apollo retries on non-2xx, but our internal failures
  // shouldn't block their pipeline. We log + best-effort process.
  res.json({ ok: true });

  // TEMPORARY full-body logging to diagnose Apollo's actual payload shape.
  // Their docs show {people:[{id,phone_numbers,personal_emails,...}]} but
  // observed live deliveries arrive with people:[] — the data must be elsewhere.
  console.log('[apollo/webhook] raw body:', JSON.stringify(req.body).slice(0, 2000));

  try {
    const people = req.body?.people || [];
    // Some Apollo webhook variants nest the result differently; try a few
    // common shapes before giving up.
    const candidates = people.length ? people : (
      req.body?.contacts ||
      req.body?.records ||
      (req.body?.person ? [req.body.person] : []) ||
      []
    );
    if (!candidates.length) {
      console.warn('[apollo/webhook] no person records in payload — top-level keys:', Object.keys(req.body || {}));
      return;
    }

    for (const person of candidates) {
      if (!person?.id) continue;

      // Apollo's actual waterfall payload: email/phone data is nested under
      // person.waterfall.{emails,phone_numbers}[].vendors[].{emails,phone_numbers}[]
      // We pick the first vendor entry that's verified/validated/successful.
      const wf = person.waterfall || {};
      const goodVendorStatuses = new Set(['VERIFIED', 'validated', 'SUCCESS', 'success']);

      let email = person.email || person.personal_emails?.[0] || null;
      if (!email) {
        outer: for (const emailGroup of (wf.emails || [])) {
          for (const v of (emailGroup.vendors || [])) {
            if (goodVendorStatuses.has(v.status) && v.emails?.length) {
              email = v.emails[0];
              break outer;
            }
          }
        }
      }

      let phone =
        person.sanitized_phone ||
        person.phone_numbers?.[0]?.sanitized_number ||
        person.phone_numbers?.[0]?.raw_number ||
        null;
      if (!phone) {
        outer: for (const phoneGroup of (wf.phone_numbers || [])) {
          for (const v of (phoneGroup.vendors || [])) {
            if (goodVendorStatuses.has(v.status) && v.phone_numbers?.length) {
              phone = v.phone_numbers[0]?.sanitized_number || v.phone_numbers[0]?.raw_number || null;
              if (phone) break outer;
            }
          }
        }
      }

      const update = {};
      if (phone) update.phone = phone;
      if (email) update.email = email;
      if (!Object.keys(update).length) {
        console.log(`[apollo/webhook] no email/phone in payload for id=${person.id}`);
        continue;
      }
      update.enrichment_source = 'apollo';

      // Owners are now the canonical contact rows. Update the matching owner;
      // never overwrite a non-null value (LeadMagic may have filled it first,
      // and we don't want async Apollo to win retroactively if it has worse
      // data). Webhook upserts also flow through to the lead's mirror fields
      // via the cron sync.
      const { data: owner } = await supabase
        .from('lead_owners')
        .select('id, email, phone')
        .eq('apollo_contact_id', person.id)
        .maybeSingle();
      if (!owner) {
        // Backwards compat: some leads still have apollo_contact_id pinned
        // directly on the leads row (pre-migration). Update there too.
        const { error } = await supabase
          .from('leads')
          .update(update)
          .eq('apollo_contact_id', person.id);
        if (error) console.warn('[apollo/webhook] legacy leads update failed', person.id, error.message);
        else console.log(`[apollo/webhook] updated leads (legacy) for apollo_contact_id=${person.id}`);
        continue;
      }
      const ownerUpdate = {};
      if (update.email && !owner.email) ownerUpdate.email = update.email;
      if (update.phone && !owner.phone) ownerUpdate.phone = update.phone;
      if (Object.keys(ownerUpdate).length) ownerUpdate.enrichment_source = 'apollo';
      if (!Object.keys(ownerUpdate).length) {
        console.log(`[apollo/webhook] owner ${owner.id} already has email/phone — skipping`);
        continue;
      }
      const { error } = await supabase
        .from('lead_owners')
        .update(ownerUpdate)
        .eq('id', owner.id);
      if (error) console.warn('[apollo/webhook] DB update failed', person.id, error.message);
      else console.log(`[apollo/webhook] updated lead_owner ${owner.id} for apollo_contact_id=${person.id}: ${Object.keys(ownerUpdate).join('+')}`);
    }
  } catch (e) {
    console.warn('[apollo/webhook] handler threw', e.message);
  }
});
