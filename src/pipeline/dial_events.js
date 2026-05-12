// Lightweight in-process pub/sub for dial-session SSE. Keyed by sessionId.
// Each subscriber gets a writable response handle so the AMD-callback route
// can push events without polling.

const subscribers = new Map(); // sessionId -> Set<res>
const callSidToSession = new Map(); // dialed-leg CallSid -> sessionId

export function registerCall(sessionId, callSid) {
  if (!sessionId || !callSid) return;
  callSidToSession.set(callSid, sessionId);
}

export function sessionForCall(callSid) {
  return callSidToSession.get(callSid) || null;
}

export function subscribe(sessionId, res) {
  if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set());
  subscribers.get(sessionId).add(res);
  return () => {
    const set = subscribers.get(sessionId);
    if (!set) return;
    set.delete(res);
    if (!set.size) subscribers.delete(sessionId);
  };
}

export function publish(sessionId, event) {
  const set = subscribers.get(sessionId);
  if (!set) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch {}
  }
}
