import express from 'express';
import twilio from 'twilio';
import { supabase } from '../db.js';
import {
  audioFileExists,
  audioPathForLead,
  announcePathForLead,
  announceFileExists,
  MY_NAME_AUDIO_PATH,
} from '../services/elevenlabs.js';
import { client, publicBaseUrl, issueAccessToken } from '../services/twilio.js';
import { logCallToApollo } from '../services/apollo.js';
import { registerCall, subscribe, publish } from '../pipeline/dial_events.js';
import fs from 'node:fs';

export const twilioRouter = express.Router();

// Identify clip ("Michael Riley from Boyne Capital.") played when AMD reports
// human on the server-side voicemail leg — typically an iPhone screener.
const IDENTIFY_AUDIO_ID = '063311c4-01eb-4517-9096-8f976f3edd8b';

// ----------------------------------------------------------------------------
// Browser dialer: access token endpoint
// ----------------------------------------------------------------------------
twilioRouter.get('/token', (req, res) => {
  try {
    const identity = req.query.identity || 'operator';
    res.json(issueAccessToken(identity));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// /connect — invoked by the TwiML App when the browser Device calls
// device.connect({ params: { leadId, toNumber, sessionId } }). Dials the lead
// from the server with answerOnBridge so the browser only hears ringback until
// pickup, then the audio bridges automatically. AMD runs on the dialed leg;
// /amd-browser handles HUMAN vs MACHINE bridging logic.
// ----------------------------------------------------------------------------
twilioRouter.post('/connect', (req, res) => {
  const { leadId, toNumber, sessionId } = req.body || {};
  const base = publicBaseUrl();
  const VR = twilio.twiml.VoiceResponse;
  const r = new VR();

  if (!toNumber) {
    r.say({ voice: 'Polly.Joanna' }, 'No phone number provided. Hanging up.');
    r.hangup();
    return res.type('text/xml').send(r.toString());
  }

  const q = (k, v) => encodeURIComponent(v == null ? '' : v);
  const dial = r.dial({
    answerOnBridge: true,
    action: `${base}/api/twilio/connect-complete?leadId=${q('leadId', leadId)}`,
    method: 'POST',
    callerId: process.env.TWILIO_PHONE_NUMBER,
    machineDetection: 'DetectMessageEnd',
    machineDetectionTimeout: 15,
    asyncAmd: 'true',
    asyncAmdStatusCallback: `${base}/api/twilio/amd-browser?leadId=${q('leadId', leadId)}&sessionId=${q('sessionId', sessionId)}`,
    asyncAmdStatusCallbackMethod: 'POST',
    record: 'record-from-answer',
  });
  dial.number({
    statusCallback: `${base}/api/twilio/status?leadId=${q('leadId', leadId)}&sessionId=${q('sessionId', sessionId)}`,
    statusCallbackEvent: 'initiated ringing answered completed',
    statusCallbackMethod: 'POST',
  }, toNumber);

  res.type('text/xml').send(r.toString());
});

// Browser leg's Dial action — fires when the dialed leg ends. Hang up the
// browser leg cleanly so the Device fires a disconnect event.
twilioRouter.post('/connect-complete', (_req, res) => {
  const VR = twilio.twiml.VoiceResponse;
  const r = new VR();
  r.hangup();
  res.type('text/xml').send(r.toString());
});

// AMD callback for the browser-dialed call. On HUMAN, the bridge is already
// live — we just publish an SSE event so the UI can stop hold music and start
// the LIVE timer. On MACHINE, we redirect the dialed leg to the standalone
// voicemail TwiML (so it leaves the bridge while playing the VM) and publish
// 'machine' so the UI advances to the next lead.
twilioRouter.post('/amd-browser', async (req, res) => {
  const { leadId, sessionId } = req.query;
  const answeredBy = req.body.AnsweredBy;
  const callSid = req.body.CallSid;
  const parentCallSid = req.body.ParentCallSid;
  const base = publicBaseUrl();

  if (callSid && sessionId) registerCall(sessionId, callSid);

  try {
    if (answeredBy === 'human') {
      publish(sessionId, { type: 'human', callSid, parentCallSid, leadId });
    } else if (answeredBy && answeredBy.startsWith('machine')) {
      // Redirect dialed leg off the bridge into /voicemail. The browser's Dial
      // verb will fire its action URL and end cleanly.
      try {
        await client().calls(callSid).update({
          url: `${base}/api/twilio/voicemail?leadId=${encodeURIComponent(leadId)}`,
          method: 'POST',
        });
      } catch (e) {
        console.warn('[twilio/amd-browser] redirect to voicemail failed', e.message);
      }
      publish(sessionId, { type: 'machine', callSid, parentCallSid, leadId, answeredBy });
    } else {
      // unknown / fax — end the call
      try { await client().calls(callSid).update({ status: 'completed' }); } catch {}
      publish(sessionId, { type: 'unknown', callSid, leadId, answeredBy });
    }
  } catch (e) {
    console.warn('[twilio/amd-browser] handler error', e.message);
  }
  res.sendStatus(200);
});

// SSE stream for the dialer UI — pushes AMD events keyed off sessionId.
twilioRouter.get('/dial-session/:sessionId/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  res.write(':\n\n');
  const unsubscribe = subscribe(req.params.sessionId, res);
  req.on('close', unsubscribe);
});

// Voicemail TwiML — plays the ElevenLabs per-lead recording then hangs up.
// The identify clip ("Michael Riley from Boyne Capital") has been removed;
// the ElevenLabs script already introduces the caller naturally.
twilioRouter.all('/voicemail', (req, res) => {
  const { leadId } = req.query;
  const base = publicBaseUrl();
  const VR = twilio.twiml.VoiceResponse;
  const r = new VR();

  r.pause({ length: 1 });

  if (leadId && audioFileExists(leadId)) {
    r.play(`${base}/audio/${leadId}.mp3`);
  } else {
    r.say({ voice: 'Polly.Joanna' }, 'Hello, I will follow up by email. Thank you.');
  }
  r.hangup();
  res.type('text/xml').send(r.toString());
});

// Status callback — captures twilio_call_sid + amd_result so the
// browser dialer's outcome modal can PATCH the row by callSid.
twilioRouter.post('/status', async (req, res) => {
  const { leadId, sessionId } = req.query;
  const status = req.body.CallStatus;
  const duration = parseInt(req.body.CallDuration || '0', 10);
  const recordingUrl = req.body.RecordingUrl || null;
  const answeredBy = req.body.AnsweredBy;
  const callSid = req.body.CallSid;
  const parentCallSid = req.body.ParentCallSid;

  // Push child SID to the UI as soon as the dialed leg is initiated so the
  // manual voicemail button can use it directly (avoids a slow REST lookup).
  if ((status === 'initiated' || status === 'ringing') && sessionId && callSid && parentCallSid) {
    publish(sessionId, { type: 'child_sid', callSid, parentCallSid });
  }

  if (status === 'completed' && leadId) {
    let outcome = 'completed';
    if (answeredBy && answeredBy.startsWith('machine')) outcome = 'voicemail';
    else if (answeredBy === 'human') outcome = 'connected';
    else if (req.body.CallStatus === 'busy') outcome = 'busy';
    else if (req.body.CallStatus === 'no-answer') outcome = 'no_answer';

    const { data: lead } = await supabase
      .from('leads')
      .select('sequence_step, apollo_contact_id, campaign_id')
      .eq('id', leadId)
      .single();

    // Upsert call_logs keyed by twilio_call_sid so the outcome-modal PATCH
    // doesn't duplicate the row. The status callback may fire before or after
    // the modal-PATCH — whichever lands first creates the row.
    const callLogRow = {
      lead_id: leadId,
      duration,
      outcome,
      recording_url: recordingUrl,
      twilio_call_sid: callSid || null,
      parent_call_sid: parentCallSid || null,
      amd_result: answeredBy || null,
      campaign_id: lead?.campaign_id || null,
    };
    if (callSid) {
      // Upsert by twilio_call_sid
      const { data: existing } = await supabase
        .from('call_logs')
        .select('id, outcome_label, notes, talk_seconds')
        .eq('twilio_call_sid', callSid)
        .maybeSingle();
      if (existing?.id) {
        await supabase.from('call_logs').update(callLogRow).eq('id', existing.id);
      } else {
        await supabase.from('call_logs').insert(callLogRow);
      }
    } else {
      await supabase.from('call_logs').insert(callLogRow);
    }

    const newStatus = outcome === 'connected' ? 'connected' : outcome === 'voicemail' ? 'voicemail' : 'called';
    const now = new Date().toISOString();
    const seq = lead?.campaign_id
      ? (await supabase.from('campaigns').select('sequence_config').eq('id', lead.campaign_id).single())?.data?.sequence_config || []
      : [];
    const currentStep = lead?.sequence_step || 0;
    // Advance by 1; if we have the sequence cap at its length (so the lead falls off the queue naturally)
    const nextStep = seq.length > 0 ? Math.min(currentStep + 1, seq.length) : currentStep + 1;
    await supabase
      .from('leads')
      .update({
        status: newStatus,
        last_action: outcome,
        last_action_date: now,
        sequence_step: nextStep,
      })
      .eq('id', leadId);
    // Mirror to lead_owners (only rows not manually overridden)
    await supabase
      .from('lead_owners')
      .update({ status: newStatus, sequence_step: nextStep })
      .eq('lead_id', leadId)
      .is('stage_overridden_at', null);

    if (lead?.apollo_contact_id) {
      logCallToApollo({
        apolloContactId: lead.apollo_contact_id,
        outcome,
        durationSec: duration,
        notes: `Twilio ${outcome}; recording: ${recordingUrl || 'n/a'}`,
      }).catch((e) => console.warn('[twilio/status] logCallToApollo failed', e.message));
    }

    if (sessionId) publish(sessionId, { type: 'status', callSid, outcome, durationSec: duration });
  }
  res.sendStatus(200);
});

// Trigger voicemail on demand — redirects the dialed child leg to /voicemail
// TwiML so it plays the ElevenLabs recording while the browser advances.
// Prefer childCallSid (sent by the UI after capturing it from the status SSE).
// Falls back to a parent-SID REST lookup if the child SID isn't available yet.
// IMPORTANT: the caller must await this response before disconnecting the
// browser leg — otherwise Twilio hangs up the child before the redirect lands.
twilioRouter.post('/trigger-voicemail', async (req, res) => {
  const { callSid, childCallSid, leadId } = req.body || {};
  if (!callSid && !childCallSid) return res.status(400).json({ error: 'callSid required' });
  const base = publicBaseUrl();
  try {
    let targetSid = childCallSid || null;
    if (!targetSid) {
      // Fall back: look up the active child leg by parent SID.
      const children = await client().calls.list({ parentCallSid: callSid, limit: 5 });
      const child = children.find(
        (c) => c.status !== 'completed' && c.status !== 'canceled' && c.status !== 'failed',
      );
      if (!child) return res.status(404).json({ error: 'No active child call found' });
      targetSid = child.sid;
    }
    await client().calls(targetSid).update({
      url: `${base}/api/twilio/voicemail?leadId=${encodeURIComponent(leadId || '')}`,
      method: 'POST',
    });
    // Hang up the parent (browser) leg so the SDK fires a clean disconnect
    // while the child leg plays the voicemail independently.
    if (callSid) {
      try { await client().calls(callSid).update({ status: 'completed' }); } catch {}
    }
    res.json({ ok: true, childSid: targetSid });
  } catch (e) {
    console.warn('[twilio/trigger-voicemail] failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Audio file serving for voicemail mp3s and pre-roll announcement clips.
// Accepts `{uuid}.mp3`, `announce_{uuid}.mp3`, and the special `my_name.mp3`.
export function audioStaticHandler(req, res) {
  const file = req.params.file;
  const announceMatch = file.match(/^announce_([a-f0-9-]+)\.mp3$/i);
  const leadMatch = file.match(/^([a-f0-9-]+)\.mp3$/i);
  let p;
  if (file === 'my_name.mp3') p = MY_NAME_AUDIO_PATH;
  else if (announceMatch) p = announcePathForLead(announceMatch[1]);
  else if (leadMatch) p = audioPathForLead(leadMatch[1]);
  else return res.sendStatus(404);
  if (!fs.existsSync(p)) return res.sendStatus(404);
  res.type('audio/mpeg');
  fs.createReadStream(p).pipe(res);
}
