import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { campaignsRouter } from './routes/campaigns.js';
import { leadsRouter, leadOwnersRouter } from './routes/leads.js';
import { twilioRouter, audioStaticHandler } from './routes/twilio.js';
import { apolloRouter } from './routes/apollo.js';
import { sourcesRouter } from './routes/sources.js';
import { startSequenceCron } from './cron/sequence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const REQUIRED_ENV = [
  'EXA_API_KEY',
  'APP_ANTHROPIC_API_KEY',
  'APOLLO_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'MY_CELL_PHONE',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'LEADMAGIC_API_KEY',
  'TWILIO_TWIML_APP_SID',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
];
const RECOMMENDED_ENV = ['PUBLIC_BASE_URL'];

function checkEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    console.warn(`[env] missing required vars: ${missing.join(', ')} — feature(s) using these will fail`);
  }
  const missingRec = RECOMMENDED_ENV.filter((k) => !process.env[k]);
  if (missingRec.length) {
    console.warn(`[env] missing recommended vars: ${missingRec.join(', ')} — Twilio webhooks need PUBLIC_BASE_URL`);
  }
  if (!missing.length && !missingRec.length) console.log('[env] all required vars present');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false }));

app.get('/healthz', (_, res) => res.json({ ok: true }));

app.use('/api/campaigns', campaignsRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/lead-owners', leadOwnersRouter);
app.use('/api/twilio', twilioRouter);
app.use('/api/apollo', apolloRouter);
app.use('/api/sources', sourcesRouter);

app.get('/audio/:file', audioStaticHandler);

// Serve the built React app
const clientDist = path.resolve(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get(/^\/(?!api|audio|healthz|recordings).*/, (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) res.status(404).send('Frontend not built. Run `npm run build`.');
  });
});

// Centralised JSON error envelope so every 4xx/5xx has a parseable body
app.use((err, req, res, _next) => {
  console.error('[server] unhandled', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  checkEnv();
  startSequenceCron();
});
