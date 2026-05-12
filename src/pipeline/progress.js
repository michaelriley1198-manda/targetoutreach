// In-memory progress tracker keyed by campaign id.
// Survives within a single Node process — fine for the fire-and-forget launch
// pattern, since a process restart would interrupt the pipeline anyway.

const _state = new Map();

export function setProgress(id, partial) {
  const prev = _state.get(id) || {};
  const next = { ...prev, ...partial, updatedAt: Date.now() };
  _state.set(id, next);
  return next;
}

export function bumpProgress(id, delta = {}) {
  const prev = _state.get(id) || {};
  const next = { ...prev };
  for (const [k, v] of Object.entries(delta)) {
    next[k] = (prev[k] || 0) + v;
  }
  next.updatedAt = Date.now();
  _state.set(id, next);
  return next;
}

export function getProgress(id) {
  return _state.get(id) || null;
}

export function clearProgress(id) {
  _state.delete(id);
}
