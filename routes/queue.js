// In-memory job queue for the Chrome extension bridge.
// LibreChat agent calls enqueue -> returns job_id
// Extension polls pull -> executes -> deliver

const jobs = new Map();  // id -> { status: 'pending'|'done'|'error', result }
const pendingList = []; // FIFO of pending job ids

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function enqueue(req, res) {
  const b = req.body || {};
  const vendor = (b.vendor || '').toLowerCase();
  if (!['costar', 'reonomy'].includes(vendor)) {
    return res.status(400).json({ error: 'vendor must be costar or reonomy' });
  }
  const id = makeId();
  const job = { id, vendor, params: b.params || {}, created: Date.now() };
  jobs.set(id, { status: 'pending', job });
  pendingList.push(id);
  res.json({ ok: true, id });
}

async function pull(req, res) {
  // Return first pending job (if any)
  while (pendingList.length) {
    const id = pendingList.shift();
    const entry = jobs.get(id);
    if (entry && entry.status === 'pending') {
      entry.status = 'in_progress';
      entry.started = Date.now();
      return res.json(entry.job);
    }
  }
  res.json({});  // empty = no pending
}

async function deliver(req, res) {
  const { id, result } = req.body || {};
  const entry = jobs.get(id);
  if (!entry) return res.status(404).json({ error: 'unknown job' });
  entry.status = 'done';
  entry.result = result;
  entry.completed = Date.now();
  res.json({ ok: true });
}

async function status(req, res) {
  const id = req.query.id;
  const entry = jobs.get(id);
  if (!entry) return res.status(404).json({ error: 'unknown job' });
  res.json({ id, status: entry.status, result: entry.result });
}

// Blocking-poll: wait up to 60s for job to complete. LibreChat agent calls this
// after enqueue to get results in a single request.
async function waitFor(req, res) {
  const id = req.query.id;
  const timeoutMs = Math.min(Number(req.query.timeout) || 90000, 120000);
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const entry = jobs.get(id);
    if (!entry) return res.status(404).json({ error: 'unknown job' });
    if (entry.status === 'done') return res.json({ id, status: 'done', result: entry.result });
    await new Promise(r => setTimeout(r, 500));
  }
  res.status(504).json({ id, status: 'timeout', message: 'extension did not deliver in time - is Chrome open with the tabs signed in?' });
}

module.exports = { enqueue, pull, deliver, status, waitFor };
