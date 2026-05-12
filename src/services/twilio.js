import twilio from 'twilio';

let _client = null;
export function client() {
  if (!_client) {
    _client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return _client;
}

// Sign a Twilio Voice access token for the browser SDK. The TwiML App SID's
// Voice URL must point at /api/twilio/connect — that's where Twilio fetches
// TwiML when the browser Device calls device.connect(). Tokens require an
// API Key SID + Secret (not the master auth token).
export function issueAccessToken(identity = 'operator') {
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKey = process.env.TWILIO_API_KEY_SID;
  const apiSecret = process.env.TWILIO_API_KEY_SECRET;
  const twimlAppSid = process.env.TWILIO_TWIML_APP_SID;
  if (!apiKey || !apiSecret) throw new Error('TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET required for access tokens');
  if (!twimlAppSid) throw new Error('TWILIO_TWIML_APP_SID required for browser dialer');

  const ttl = 3600;
  const token = new AccessToken(accountSid, apiKey, apiSecret, { identity, ttl });
  token.addGrant(new VoiceGrant({
    outgoingApplicationSid: twimlAppSid,
    incomingAllow: false,
  }));
  return { token: token.toJwt(), identity, ttl };
}

export function publicBaseUrl() {
  // PUBLIC_BASE_URL must be a publicly reachable HTTPS URL (Twilio webhook target).
  return (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
}
