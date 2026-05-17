import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Device } from '@twilio/voice-sdk';
import { api } from '../api.js';
import LogOutcomeModal from '../components/LogOutcomeModal.jsx';

// Phases:
//   booting → device_ready → running | paused | ended
// Per-call: announcing → dialing → ringing → live | vm | noanswer
//   live → outcome → (next announcing)
const NO_ANSWER_MS = 55_000;
const VM_TIMEOUT_MS = 60_000;

export default function DialSession() {
  const { id } = useParams();
  const nav = useNavigate();

  const [phase, setPhase] = useState('booting');
  const [callPhase, setCallPhase] = useState('idle');
  const [queue, setQueue] = useState([]);
  const [current, setCurrent] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [callSid, setCallSid] = useState(null);
  const [talkSeconds, setTalkSeconds] = useState(0);
  const [err, setErr] = useState(null);
  const [micOk, setMicOk] = useState(null);
  const [paused, setPaused] = useState(false);
  const [sayingName, setSayingName] = useState(false);
  const [muted, setMuted] = useState(false);
  const [droppingVm, setDroppingVm] = useState(false);

  const deviceRef        = useRef(null);
  const callRef          = useRef(null);
  const sseRef           = useRef(null);
  const announceRef      = useRef(null);
  const liveTimerRef     = useRef(null);
  const noAnswerTimerRef = useRef(null);
  const vmTimeoutRef     = useRef(null);
  const callSidRef       = useRef(null);
  const childCallSidRef  = useRef(null);

  // Refs that async callbacks read — avoids stale closure bugs
  const callPhaseRef = useRef('idle');
  const pausedRef    = useRef(false);
  const sessionIdRef = useRef(null);
  // Guards against double-advance
  const advancingRef = useRef(false);

  useEffect(() => { callPhaseRef.current = callPhase; }, [callPhase]);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { callSidRef.current = callSid; }, [callSid]);

  function setCallPhaseSync(p) {
    callPhaseRef.current = p;
    setCallPhase(p);
  }

  // ----- boot -----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { token } = await api.getTwilioToken();
        if (cancelled) return;
        const device = new Device(token, { logLevel: 'warn', codecPreferences: ['opus', 'pcmu'] });
        device.on('registered', () => !cancelled && setPhase('device_ready'));
        device.on('error', (e) => setErr(`Device: ${e.message || e}`));
        await device.register();
        deviceRef.current = device;
      } catch (e) {
        setErr(`Token / Device init failed: ${e.message}`);
      }
    })();
    return () => {
      cancelled = true;
      try { deviceRef.current?.destroy(); } catch {}
      try { sseRef.current?.close(); } catch {}
      stopAll();
    };
  }, []);

  async function testMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMicOk(true);
    } catch (e) {
      setMicOk(false);
      setErr(`Microphone permission denied: ${e.message}`);
    }
  }

  async function startSession() {
    setErr(null);
    setPhase('running');
    setPaused(false);
    pausedRef.current = false;
    try {
      const { session_id, leads } = await api.dial(id, null);
      if (!session_id || !leads?.length) {
        setErr('No leads in the call queue.');
        setPhase('device_ready');
        return;
      }
      setSessionId(session_id);
      sessionIdRef.current = session_id;
      setQueue(leads);

      const es = api.dialSessionEvents(session_id);
      es.onmessage = (msg) => {
        try { handleAmdEvent(JSON.parse(msg.data)); } catch {}
      };
      sseRef.current = es;
      dialNext(leads);
    } catch (e) {
      setErr(e.message);
      setPhase('device_ready');
    }
  }

  function stopAll() {
    try { announceRef.current?.pause(); announceRef.current = null; } catch {}
    clearInterval(liveTimerRef.current);
    clearTimeout(noAnswerTimerRef.current);
    clearTimeout(vmTimeoutRef.current);
  }

  async function dialNext(remaining) {
    advancingRef.current = false;
    stopAll();
    setSayingName(false);
    setMuted(false);
    setDroppingVm(false);
    childCallSidRef.current = null;

    if (pausedRef.current) { setCallPhaseSync('idle'); return; }
    if (!remaining?.length) { setPhase('ended'); setCurrent(null); return; }

    const lead = remaining[0];
    setCurrent(lead);
    setCallSid(null);
    callSidRef.current = null;
    setTalkSeconds(0);

    // 1) Announce who we're calling
    setCallPhaseSync('announcing');
    await new Promise((resolve) => {
      try {
        const a = new Audio(`/audio/announce_${lead.id}.mp3`);
        announceRef.current = a;
        a.onended = resolve;
        a.onerror = resolve;
        a.play().catch(resolve);
      } catch { resolve(); }
    });
    announceRef.current = null;

    if (pausedRef.current) { setCallPhaseSync('idle'); return; }

    // 2) Dial
    setCallPhaseSync('dialing');
    try {
      const call = await deviceRef.current.connect({
        params: { leadId: lead.id, toNumber: lead.phone, sessionId: sessionIdRef.current },
      });
      callRef.current = call;

      call.on('accept',  () => setCallPhaseSync('ringing'));
      call.on('ringing', () => setCallPhaseSync('ringing'));

      const sid = call.parameters?.CallSid || call.outboundConnectionId || null;
      if (sid) { setCallSid(sid); callSidRef.current = sid; }

      call.on('disconnect', () => {
        clearInterval(liveTimerRef.current);
        clearTimeout(noAnswerTimerRef.current);

        // Skip already called advance() — don't double-advance or show outcome modal
        if (advancingRef.current) return;

        const cp = callPhaseRef.current;
        if (cp === 'live') {
          setCallPhaseSync('outcome');
        } else if (cp === 'vm') {
          // Server-side leg still playing voicemail — wait for status SSE
        } else {
          advance(remaining);
        }
      });

      call.on('error', (e) => {
        setErr(`Call: ${e.message || e}`);
        advance(remaining);
      });

      // 30s no-answer timer
      noAnswerTimerRef.current = setTimeout(() => {
        if (callPhaseRef.current === 'dialing' || callPhaseRef.current === 'ringing') {
          setCallPhaseSync('noanswer');
          try { call.disconnect(); } catch {}
        }
      }, NO_ANSWER_MS);

      callRef._remaining = remaining;
    } catch (e) {
      setErr(`Dial failed: ${e.message}`);
      advance(remaining);
    }
  }

  function handleAmdEvent(ev) {
    // Capture child call SID as early as possible (status callback pushes it on
    // initiated/ringing; AMD callback carries it on human/machine).
    if (ev.callSid && (ev.type === 'child_sid' || ev.type === 'human' || ev.type === 'machine')) {
      childCallSidRef.current = ev.callSid;
    }

    // Ignore AMD detection events once we're already live — prevents late or
    // duplicate SSE events from interfering with an active conversation.
    const cp = callPhaseRef.current;
    if (ev.type !== 'status' && ev.type !== 'child_sid' && (cp === 'live' || cp === 'outcome')) return;

    if (ev.type === 'human') {
      clearTimeout(noAnswerTimerRef.current);
      try { callRef.current?.mute(false); } catch {}
      setMuted(false);
      setCallPhaseSync('live');
      let t = 0;
      liveTimerRef.current = setInterval(() => { t += 1; setTalkSeconds(t); }, 1000);

    } else if (ev.type === 'machine') {
      setCallPhaseSync('vm');
      const rem = callRef._remaining;
      vmTimeoutRef.current = setTimeout(() => {
        if (callPhaseRef.current === 'vm') advance(rem);
      }, VM_TIMEOUT_MS);

    } else if (ev.type === 'unknown') {
      // AMD couldn't classify — leave call up; 55s no-answer timer handles cleanup

    } else if (ev.type === 'status') {
      if (callPhaseRef.current === 'vm') {
        clearTimeout(vmTimeoutRef.current);
        setTimeout(() => advance(callRef._remaining), 400);
      }
    }
  }

  // Inject pre-recorded "Michael Riley" clip through the active WebRTC call.
  // Uses RTCPeerConnection.getSenders() to temporarily replace the mic track.
  async function sayMyName() {
    if (sayingName) return;
    setSayingName(true);
    try {
      const resp = await fetch('/audio/my_name.mp3');
      const buf = await resp.arrayBuffer();
      const audioCtx = new AudioContext();
      const audioBuffer = await audioCtx.decodeAudioData(buf);

      // Find the audio sender on the underlying RTCPeerConnection
      const pc = callRef.current?._peerConnection;
      const sender = pc?.getSenders?.().find((s) => s.track?.kind === 'audio');

      if (sender) {
        const originalTrack = sender.track;
        const dest = audioCtx.createMediaStreamDestination();
        const src = audioCtx.createBufferSource();
        src.buffer = audioBuffer;
        src.connect(dest);
        await sender.replaceTrack(dest.stream.getAudioTracks()[0]);
        src.start();
        src.onended = async () => {
          try { await sender.replaceTrack(originalTrack); } catch {}
          audioCtx.close();
          setSayingName(false);
        };
      } else {
        // Fallback: play locally so agent can state name manually
        console.warn('[sayMyName] RTCPeerConnection sender not accessible — playing locally only');
        const audio = new Audio('/audio/my_name.mp3');
        audio.onended = () => setSayingName(false);
        audio.onerror = () => setSayingName(false);
        audio.play().catch(() => setSayingName(false));
      }
    } catch (e) {
      console.warn('[sayMyName] failed', e.message);
      setSayingName(false);
    }
  }

  // Drop voicemail and immediately advance to the next lead.
  // Must AWAIT the server redirect before disconnecting — otherwise Twilio
  // hangs up the child call when the parent disconnects and no VM plays.
  async function leaveVoicemail() {
    if (droppingVm) return;
    const sid = callSidRef.current;
    const childSid = childCallSidRef.current;
    const rem = callRef._remaining;
    const leadId = rem?.[0]?.id;

    setDroppingVm(true);
    clearTimeout(noAnswerTimerRef.current);
    clearInterval(liveTimerRef.current);
    // Lock advancing before the await so any stray disconnect event during the
    // network call doesn't double-advance.
    advancingRef.current = true;

    try {
      await fetch('/api/twilio/trigger-voicemail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callSid: sid, childCallSid: childSid, leadId }),
      });
    } catch (e) {
      console.warn('[leaveVoicemail] trigger failed', e.message);
    }

    // Redirect is confirmed — now safe to drop the browser leg.
    try { callRef.current?.disconnect(); } catch {}
    advance(rem);
  }

  // Hang up the active call cleanly. The disconnect handler takes over:
  // shows the outcome modal if live, advances otherwise.
  function hangUp() {
    try { callRef.current?.disconnect(); } catch {}
  }

  function advance(remaining) {
    if (advancingRef.current) return;
    advancingRef.current = true;
    setCallPhaseSync('idle');
    const rem = remaining || callRef._remaining;
    const rest = Array.isArray(rem) ? rem.slice(1) : [];
    setQueue(rest);
    if (pausedRef.current) return;
    setTimeout(() => dialNext(rest), 300);
  }

  async function submitOutcome({ outcome_label, notes, talk_seconds }) {
    if (callSid) {
      try { await api.logCallOutcome(callSid, { outcome_label, notes, talk_seconds }); }
      catch (e) { console.warn('logCallOutcome failed', e.message); }
    }
    advance(callRef._remaining);
  }

  function skipOutcome() { advance(callRef._remaining); }

  function toggleMute() {
    const next = !muted;
    try { callRef.current?.mute(next); } catch {}
    setMuted(next);
  }

  function skipCurrent() {
    stopAll();
    // Lock advancingRef BEFORE disconnect so the call's disconnect handler
    // sees it and bails out — prevents a double-advance race.
    advancingRef.current = true;
    try { callRef.current?.disconnect(); } catch {}
    setCallPhaseSync('idle');
    const rest = queue.slice(1);
    setQueue(rest);
    if (!pausedRef.current) setTimeout(() => dialNext(rest), 300);
  }

  function togglePause() {
    setPaused((p) => {
      const next = !p;
      pausedRef.current = next;
      if (!next && callPhaseRef.current === 'idle') dialNext(queue);
      return next;
    });
  }

  function endSession() {
    try { sseRef.current?.close(); } catch {}
    stopAll();
    try { callRef.current?.disconnect(); } catch {}
    nav(`/campaigns/${id}`);
  }

  // ----- render -----
  if (err) return (
    <div className="error" style={{ padding: 20 }}>
      {err}
      <div style={{ marginTop: 12 }}><Link to={`/campaigns/${id}`}>← Back to campaign</Link></div>
    </div>
  );

  if (phase === 'booting') return <div className="loading">Initializing Twilio Device…</div>;

  if (phase === 'device_ready') return (
    <div className="form-page">
      <h1>Browser Dialer</h1>
      <p className="muted">Twilio Device registered. Test your microphone, then start dialing.</p>
      <div className="row">
        <button onClick={testMic}>Test microphone</button>
        {micOk === true && <span className="muted small">✓ mic OK</span>}
        {micOk === false && <span className="error small">mic blocked</span>}
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        <button className="primary" onClick={startSession}>Start Dialing</button>
        <Link to={`/campaigns/${id}`} className="ghost-link">Back to campaign</Link>
      </div>
    </div>
  );

  if (phase === 'ended') return (
    <div className="empty">
      <p>Session complete.</p>
      <Link to={`/campaigns/${id}`}>← Back to campaign</Link>
    </div>
  );

  if (!current) return <div className="loading">Loading next lead…</div>;

  const bio = current.bio_json || {};
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  const phaseLabel = {
    idle:       'IDLE',
    announcing: 'ANNOUNCING',
    dialing:    'DIALING',
    ringing:    'RINGING',
    live:       'LIVE',
    vm:         'LEAVING VOICEMAIL',
    noanswer:   'NO ANSWER',
    outcome:    'LOG OUTCOME',
  }[callPhase] ?? callPhase.toUpperCase();

  return (
    <div className="dial-session">
      <div className="dial-bar">
        <div className={`status ${callPhase}`}>
          <span className="dot" /> {phaseLabel}
          {callPhase === 'live' && <span className="timer"> {fmt(talkSeconds)}</span>}
        </div>
        <div className="row">
          {callPhase === 'live' && (
            <button onClick={sayMyName} disabled={sayingName}>
              {sayingName ? 'Playing…' : 'Say my name'}
            </button>
          )}
          {['ringing', 'live'].includes(callPhase) && (
            <button onClick={leaveVoicemail} disabled={droppingVm}>
              {droppingVm ? 'Dropping…' : 'Drop Voicemail & Next'}
            </button>
          )}
          {['dialing', 'ringing', 'live'].includes(callPhase) && (
            <>
              <button onClick={toggleMute}>{muted ? 'Unmute' : 'Mute'}</button>
              <button className="danger" onClick={hangUp}>Hang Up</button>
            </>
          )}
          <button onClick={skipCurrent} disabled={callPhase === 'idle'}>Skip</button>
          <button onClick={togglePause}>{paused ? 'Resume' : 'Pause'}</button>
          <button className="ghost" onClick={endSession}>End Session</button>
        </div>
      </div>

      <div className="dial-grid">
        <div className="card">
          <h2>{current.company_name}</h2>
          <p className="muted">{current.company_url}</p>
          <div className="row gap">
            <div><b>Contact:</b> {current.contact_name || '—'}</div>
            <div><b>Title:</b> {current.contact_title || '—'}</div>
          </div>
          <div className="row gap">
            <div><b>Phone:</b> {current.phone || '—'}</div>
            <div><b>Email:</b> {current.email || '—'}</div>
          </div>
          <div className="row gap">
            <div><b>Revenue:</b> {current.revenue || '—'}</div>
            <div><b>EBITDA:</b> {current.ebitda || '—'}</div>
            <div><b>Employees:</b> {current.employees || '—'}</div>
            <div><b>Location:</b> {current.location || '—'}</div>
          </div>
          <h4>Description</h4><p>{current.description}</p>
          <h4>Fit Rationale</h4><p>{current.fit_rationale}</p>
          {current.flags && (<><h4>Flags</h4><p className="warn">{current.flags}</p></>)}
        </div>

        <div className="card">
          {bio.ice_breakers?.length > 0 && (<><h3>Ice Breakers</h3><ul>{bio.ice_breakers.map((x, i) => <li key={i}>{x}</li>)}</ul></>)}
          {bio.industry_news?.length > 0 && (<><h3>Industry News</h3><ul>{bio.industry_news.map((x, i) => <li key={i}>{x}</li>)}</ul></>)}
          {bio.talking_points?.length > 0 && (<><h3>Talking Points</h3><ul>{bio.talking_points.map((x, i) => <li key={i}>{x}</li>)}</ul></>)}
        </div>
      </div>

      <div className="queue-preview">
        <h3>Up Next ({Math.max(queue.length - 1, 0)})</h3>
        <ul>
          {queue.slice(1, 6).map((l) => (
            <li key={l.id}>
              <span className="score">{l.priority_score}</span>
              <b>{l.company_name}</b> — {l.contact_name || '(no contact)'}
            </li>
          ))}
        </ul>
      </div>

      {callPhase === 'outcome' && (
        <LogOutcomeModal lead={current} talkSeconds={talkSeconds} onSubmit={submitOutcome} onSkip={skipOutcome} />
      )}
    </div>
  );
}
