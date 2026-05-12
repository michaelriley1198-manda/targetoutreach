import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Device } from '@twilio/voice-sdk';
import { api } from '../api.js';
import LogOutcomeModal from '../components/LogOutcomeModal.jsx';

// State machine:
//   booting → device_ready → idle
//   per lead: announcing → dialing → ringing → (live | vm | noanswer)
//   live → outcome_modal → idle
// "Pause" stops new dials after current call resolves.
const NO_ANSWER_MS = 30_000;

export default function DialSession() {
  const { id } = useParams();
  const nav = useNavigate();

  const [phase, setPhase] = useState('booting'); // booting | device_ready | running | paused | ended
  const [callPhase, setCallPhase] = useState('idle'); // idle | announcing | dialing | ringing | live | vm | noanswer | outcome
  const [queue, setQueue] = useState([]);
  const [current, setCurrent] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [callSid, setCallSid] = useState(null);
  const [talkSeconds, setTalkSeconds] = useState(0);
  const [err, setErr] = useState(null);
  const [micOk, setMicOk] = useState(null);
  const [paused, setPaused] = useState(false);

  const deviceRef = useRef(null);
  const callRef = useRef(null);
  const sseRef = useRef(null);
  const announceRef = useRef(null);
  const holdMusicRef = useRef(null);
  const liveAudioElRef = useRef(null);
  const liveTimerRef = useRef(null);
  const noAnswerTimerRef = useRef(null);

  // ----- boot: fetch token, init Twilio Device, request mic -----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { token } = await api.getTwilioToken();
        if (cancelled) return;
        const device = new Device(token, {
          logLevel: 'warn',
          codecPreferences: ['opus', 'pcmu'],
        });
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
      stopAudio();
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
    try {
      const { session_id, leads } = await api.dial(id, null);
      if (!session_id || !leads?.length) {
        setErr('No leads in the call queue.');
        setPhase('device_ready');
        return;
      }
      setSessionId(session_id);
      setQueue(leads);
      // Open SSE stream for AMD events
      const es = api.dialSessionEvents(session_id);
      es.onmessage = (msg) => {
        try {
          const ev = JSON.parse(msg.data);
          handleAmdEvent(ev);
        } catch {}
      };
      sseRef.current = es;
      dialNext(leads);
    } catch (e) {
      setErr(e.message);
      setPhase('device_ready');
    }
  }

  function stopAudio() {
    try { announceRef.current?.pause(); } catch {}
    try { if (holdMusicRef.current) { holdMusicRef.current.pause(); holdMusicRef.current.currentTime = 0; } } catch {}
    clearInterval(liveTimerRef.current);
    clearTimeout(noAnswerTimerRef.current);
  }

  async function dialNext(remaining) {
    const q = remaining || queue;
    if (paused) { setCallPhase('idle'); return; }
    if (!q.length) {
      setPhase('ended');
      setCurrent(null);
      return;
    }
    const lead = q[0];
    setCurrent(lead);
    setCallSid(null);
    setTalkSeconds(0);

    // 1) Play announcement
    setCallPhase('announcing');
    try {
      announceRef.current = new Audio(`/audio/announce_${lead.id}.mp3`);
      await new Promise((resolve) => {
        announceRef.current.onended = resolve;
        announceRef.current.onerror = resolve;
        announceRef.current.play().catch(resolve);
      });
    } catch {}

    // 2) Start hold music looping (will be stopped on AMD event)
    try {
      holdMusicRef.current = new Audio('https://demo.twilio.com/docs/classic.mp3');
      holdMusicRef.current.loop = true;
      holdMusicRef.current.volume = 0.5;
      holdMusicRef.current.play().catch(() => {});
    } catch {}

    // 3) Place the outbound call via Device.connect; Twilio fetches TwiML
    // from our /api/twilio/connect endpoint with these params.
    setCallPhase('dialing');
    try {
      const call = await deviceRef.current.connect({
        params: { leadId: lead.id, toNumber: lead.phone, sessionId },
      });
      callRef.current = call;
      // Mute the bridge audio until AMD confirms HUMAN — the user only hears
      // hold music until AMD classifies.
      try { call.mute(true); } catch {}
      call.on('accept', () => setCallPhase('ringing'));
      call.on('ringing', () => setCallPhase('ringing'));
      // The dialed call's SID arrives on the parameters event in some versions;
      // we read it from the call object itself.
      const sid = call.parameters?.CallSid || call.outboundConnectionId || null;
      if (sid) setCallSid(sid);
      call.on('disconnect', () => {
        // Server-side leg ended; either we got LIVE and user hung up, or
        // server redirected to /voicemail and our parent leg's Dial action
        // hung up the browser. Either way: if we were LIVE, show outcome modal.
        clearInterval(liveTimerRef.current);
        clearTimeout(noAnswerTimerRef.current);
        try { holdMusicRef.current?.pause(); } catch {}
        if (callPhaseRef.current === 'live') {
          setCallPhase('outcome');
        } else {
          // Advance silently (no outcome modal for VM / no-answer)
          advance();
        }
      });
      call.on('error', (e) => { setErr(`Call: ${e.message || e}`); advance(); });

      // 30s no-answer timer
      noAnswerTimerRef.current = setTimeout(() => {
        if (callPhaseRef.current === 'dialing' || callPhaseRef.current === 'ringing') {
          setCallPhase('noanswer');
          try { call.disconnect(); } catch {}
        }
      }, NO_ANSWER_MS);
    } catch (e) {
      setErr(`Dial failed: ${e.message}`);
      advance();
    }
  }

  // Mirror callPhase in a ref so async handlers can branch on the freshest value
  const callPhaseRef = useRef(callPhase);
  useEffect(() => { callPhaseRef.current = callPhase; }, [callPhase]);

  function handleAmdEvent(ev) {
    if (ev.type === 'human') {
      try { holdMusicRef.current?.pause(); } catch {}
      try { callRef.current?.mute(false); } catch {}
      setCallPhase('live');
      let t = 0;
      liveTimerRef.current = setInterval(() => { t += 1; setTalkSeconds(t); }, 1000);
    } else if (ev.type === 'machine') {
      try { holdMusicRef.current?.pause(); } catch {}
      setCallPhase('vm');
      // Disconnect the browser side; server-side call keeps playing VM.
      try { callRef.current?.disconnect(); } catch {}
      setTimeout(advance, 800);
    } else if (ev.type === 'unknown') {
      try { holdMusicRef.current?.pause(); } catch {}
      try { callRef.current?.disconnect(); } catch {}
      advance();
    }
  }

  function advance() {
    setCallPhase('idle');
    setQueue((q) => {
      const rest = q.slice(1);
      // Dial next in the next tick so React state has settled
      setTimeout(() => dialNext(rest), 200);
      return rest;
    });
  }

  async function submitOutcome({ outcome_label, notes, talk_seconds }) {
    if (callSid) {
      try {
        await api.logCallOutcome(callSid, { outcome_label, notes, talk_seconds });
      } catch (e) {
        console.warn('logCallOutcome failed', e.message);
      }
    }
    advance();
  }

  function skipOutcome() { advance(); }
  function skipCurrent() {
    try { callRef.current?.disconnect(); } catch {}
    advance();
  }
  function togglePause() {
    setPaused((p) => {
      const next = !p;
      if (!next && callPhase === 'idle') dialNext();
      return next;
    });
  }
  function endSession() {
    try { sseRef.current?.close(); } catch {}
    stopAudio();
    try { callRef.current?.disconnect(); } catch {}
    nav(`/campaigns/${id}`);
  }

  // ----- render -----
  if (err) return (
    <div className="error" style={{ padding: 20 }}>
      {err}
      <div style={{ marginTop: 12 }}>
        <Link to={`/campaigns/${id}`}>← Back to campaign</Link>
      </div>
    </div>
  );

  if (phase === 'booting') return <div className="loading">Initializing Twilio Device…</div>;

  if (phase === 'device_ready') {
    return (
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
  }

  if (phase === 'ended') {
    return (
      <div className="empty">
        <p>Session complete.</p>
        <Link to={`/campaigns/${id}`}>← Back to campaign</Link>
      </div>
    );
  }

  if (!current) return <div className="loading">Loading next lead…</div>;

  const bio = current.bio_json || {};
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div className="dial-session">
      <div className="dial-bar">
        <div className={`status ${callPhase}`}>
          <span className="dot" /> {callPhase.toUpperCase()}
          {callPhase === 'live' && <span className="timer"> {fmt(talkSeconds)}</span>}
        </div>
        <div className="row">
          <button onClick={skipCurrent}>Skip</button>
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
