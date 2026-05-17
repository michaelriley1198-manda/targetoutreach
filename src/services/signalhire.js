import axios from 'axios';

const BASE = 'https://www.signalhire.com/api/v1';
const TIMEOUT = 30_000;

function headers() {
  return { apikey: process.env.SIGNALHIRE_API_KEY, 'Content-Type': 'application/json' };
}

// Request contact enrichment for up to 100 identifiers (LinkedIn URLs or emails).
// Results arrive asynchronously at callbackUrl as:
//   [{ item, status, candidate: { contacts: [{ type, value, subType }] } }]
export async function requestContacts(items, callbackUrl) {
  if (!process.env.SIGNALHIRE_API_KEY || !items?.length || !callbackUrl) return null;
  try {
    await axios.post(
      `${BASE}/candidate/search`,
      { items, callbackUrl },
      { headers: headers(), timeout: TIMEOUT }
    );
    return true;
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.message || e.message;
    console.warn('[signalhire] requestContacts failed', status, msg);
    return null;
  }
}

// Extract the best phone and email from a Signal Hire contacts array.
export function parseContacts(contacts = []) {
  const phones = contacts.filter((c) => c.type === 'phone');
  const emails = contacts.filter((c) => c.type === 'email');
  const phone =
    phones.find((p) => p.subType === 'mobile')?.value ||
    phones.find((p) => p.subType === 'work_phone')?.value ||
    phones[0]?.value ||
    null;
  const email =
    emails.find((e) => e.subType === 'work')?.value ||
    emails[0]?.value ||
    null;
  return { phone, email };
}
