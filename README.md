# targetoutreach

PE deal sourcing automation: multi-source acquisition → enrichment → outreach → browser-based dialing. Express + Supabase + React, deploy-ready for Railway.

## Pipeline

1. **Acquisition (combinable)** — pick any subset on the New Campaign wizard's Sources step:
   - **Exa Search** — Claude generates diverse neural search queries; Exa runs them; Claude filters + enriches.
   - **Apollo Search** — Claude extracts structured filters from the brief; Apollo's Organization Search returns up to 500 companies with native firmographics.
   - **Apollo Saved List** — import every company attached to a saved label.
   - **CSV Upload** — flexible column mapping; same-domain rows merge into a single lead with multiple contacts.
   Results merge and dedupe by domain (precedence: Apollo Search > Apollo List > CSV > Exa).
2. **Firmographics backfill (Apollo Organization Enrichment)** — for Exa/CSV leads missing industry/employees/revenue/location.
3. **Contact enrichment** — Apollo first (`/people/match` waterfall via webhook). LeadMagic fallback is gated behind a button on the campaign detail page.
4. **Email sequencing (Apollo)** — emailer_campaign created at launch; contacts added; cron syncs progress hourly.
5. **Browser-based WebRTC dialer (Twilio Voice SDK)** — user wears a headset and talks through the browser. Per-lead announcement clip plays before each dial; hold music covers the connect; AMD branches to LIVE (bridge through to headset) or MACHINE (advance UI; server-side leg silently completes the voicemail).

## Setup

1. **Schema** — paste `src/schema.sql` into the Supabase SQL editor.
2. **Env** (`.env`):
   - `EXA_API_KEY`, `APP_ANTHROPIC_API_KEY`, `APOLLO_API_KEY`
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `MY_CELL_PHONE`
   - `TWILIO_TWIML_APP_SID` — TwiML App SID with Voice URL set to `${PUBLIC_BASE_URL}/api/twilio/connect`
   - `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` — API Key pair from Twilio console (required for Voice access tokens; NOT the master auth token)
   - `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`
   - `LEADMAGIC_API_KEY` — used by the gated LeadMagic fallback button
   - `SUPABASE_URL`, `SUPABASE_KEY`
   - `PUBLIC_BASE_URL` — Twilio webhook target (e.g. your Railway URL)
3. **Twilio console setup**:
   - Create a TwiML App; set its Voice URL → `${PUBLIC_BASE_URL}/api/twilio/connect`; capture the SID into `TWILIO_TWIML_APP_SID`.
   - Create an API Key + Secret pair under Account → API keys; set `TWILIO_API_KEY_SID` and `TWILIO_API_KEY_SECRET`.
4. **Hold music** — drop a short royalty-free loop at `client/public/hold-music.mp3`.
5. **Install + run**:
   ```
   npm install   # builds client via postinstall
   npm start
   ```
6. **Local dev**:
   ```
   npm run dev          # backend on :3000
   cd client && npm run dev   # frontend on :5173 with /api proxied
   ```

## Railway

- Connect the repo; Railway runs `npm install` then `npm start`.
- Set every env var in the dashboard, including the four new Twilio + LeadMagic ones.
- Set `PUBLIC_BASE_URL` to the Railway HTTPS URL.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/campaigns` | create |
| GET | `/api/campaigns` | list with stats |
| GET | `/api/campaigns/:id` | detail with leads |
| PATCH | `/api/campaigns/:id` | update name/status/templates/script/sequence |
| POST | `/api/campaigns/:id/generate-prompts` | preview Exa queries |
| POST | `/api/campaigns/:id/launch` | run multi-source pipeline (background) |
| POST | `/api/campaigns/:id/reveal-contacts` | Apollo waterfall reveal |
| POST | `/api/campaigns/:id/leadmagic-fallback` | gated LeadMagic email/mobile fallback |
| GET | `/api/campaigns/:id/call-queue` | leads ready for calls |
| POST | `/api/campaigns/:id/dial` | prepare browser dialer session (synth announce + VM audio) |
| PATCH | `/api/campaigns/call-logs/:callSid/outcome` | log post-call outcome + notes |
| GET | `/api/sources/apollo-labels` | list Apollo saved labels |
| POST | `/api/sources/apollo-filters/preview` | Claude-extracted Apollo Search filters |
| POST | `/api/sources/apollo-search/preview` | sample 25 companies for the filter preview |
| POST | `/api/sources/csv/preview` | upload CSV, return column map + staging_id |
| GET | `/api/twilio/token` | issue Voice access token for the browser SDK |
| GET | `/api/twilio/dial-session/:sessionId/events` | SSE stream of AMD events |

Twilio webhooks: `/api/twilio/{connect,connect-complete,amd-browser,voicemail,status}`. Audio: `/audio/{leadId}.mp3` (VM), `/audio/announce_{leadId}.mp3` (pre-roll).

## Notes

- The launch endpoint returns immediately; the pipeline runs in the background. Refresh the campaign detail page to watch leads populate.
- Voicemail + announcement MP3s are cached under `audio_cache/` keyed by lead id.
- AMD HUMAN keeps the dialed leg bridged to the browser (operator hears live). AMD MACHINE redirects the dialed leg to `/voicemail` server-side; the operator advances to the next lead while the VM plays out.
- LeadMagic fallback only runs when the user clicks the button on the campaign detail page — never automatic at launch.
