'use strict';

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const LICENSE_BASE = (process.env.LICENSE_SERVER_BASE || '').replace(/\/+$/, '');
const UPDATE_TOKEN = process.env.UPDATE_FEE_API_TOKEN || '';
const OXAPAY_KEY = process.env.OXAPAY_MERCHANT_API_KEY || '';
const PUBLIC_URL = (process.env.APP_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const DATA_FILE = path.join(__dirname, 'data', 'orders.json');

/** Server-side poll for OxaPay confirmation if the user closes the tab (ms). Default 35s, min 15s. */
const PENDING_PAYMENT_POLL_MS = Math.max(15000, Number(process.env.PENDING_PAYMENT_POLL_MS || 35000));
/** Stop polling orders older than this (ms). Default 2h. */
const PENDING_PAYMENT_MAX_ORDER_AGE_MS = Math.max(
  15 * 60 * 1000,
  Number(process.env.PENDING_PAYMENT_MAX_ORDER_AGE_MS || 2 * 60 * 60 * 1000)
);

/**
 * License server update-fee API: only these `project_type` strings are valid (no aliases).
 * @see UPDATE_FEE_PROJECT_TYPES in .env to override order or list if your server adds types later.
 */
const OFFICIAL_PROJECT_TYPES = ['Quotex', 'Quotex Low Quality'];

function loadProjectTypes() {
  const raw = (process.env.UPDATE_FEE_PROJECT_TYPES || '').trim();
  if (!raw) return [...OFFICIAL_PROJECT_TYPES];
  const parts = raw.includes('|') ? raw.split('|') : raw.split(',');
  const seen = new Set();
  const out = [];
  for (const p of parts.map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean)) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.length ? out : [...OFFICIAL_PROJECT_TYPES];
}

const PROJECT_TYPES = loadProjectTypes();

let storeWriteChain = Promise.resolve();

async function readStore() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (!j.orders) j.orders = {};
    return j;
  } catch {
    return { orders: {} };
  }
}

async function writeStore(store) {
  await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
}

async function withStore(mutator) {
  return new Promise((resolve, reject) => {
    storeWriteChain = storeWriteChain.then(async () => {
      try {
        const store = await readStore();
        const result = await mutator(store);
        await writeStore(store);
        resolve(result);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Normalize pasted keys: strip BOM, spaces; if 16 A–Z/0–9, format as XXXX-XXXX-XXXX-XXXX. */
function normLicense(s) {
  let t = String(s || '').replace(/^\uFEFF/, '').trim();
  const compact = t.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (compact.length === 16) {
    return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}`;
  }
  return t
    .replace(/\s+/g, '')
    .toUpperCase();
}

function updateFeeHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (UPDATE_TOKEN) {
    h.Authorization = `Bearer ${UPDATE_TOKEN}`;
    h['X-Update-Fee-Key'] = UPDATE_TOKEN;
  }
  return h;
}

function extractUpdateFeeCode(httpStatus, raw) {
  if (raw && typeof raw === 'object') {
    const c = raw.code ?? raw.Code ?? raw?.data?.code;
    if (c != null && String(c).length) return String(c);
  }
  if (httpStatus === 404) return 'LICENSE_NOT_FOUND';
  if (httpStatus === 401) return 'INVALID_TOKEN';
  return undefined;
}

async function parseJsonResponse(r) {
  const text = await r.text();
  let raw = {};
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = { _non_json: text ? text.slice(0, 400) : '' };
  }
  const code = extractUpdateFeeCode(r.status, raw);
  const data = code != null ? { ...raw, code } : raw;
  return { httpStatus: r.status, data, text };
}

async function licensePending(license_key, project_type) {
  const url = `${LICENSE_BASE}/api/v1/update-fee/pending`;
  const r = await fetch(url, {
    method: 'POST',
    headers: updateFeeHeaders(),
    body: JSON.stringify({ license_key, project_type }),
  });
  const { httpStatus, data } = await parseJsonResponse(r);
  if (process.env.UPDATE_FEE_DEBUG === '1') {
    // eslint-disable-next-line no-console
    console.warn('[update-fee/pending]', { project_type, httpStatus, code: data?.code });
  }
  return { httpStatus, data };
}

async function licenseActivate(license_key, project_type) {
  const url = `${LICENSE_BASE}/api/v1/update-fee/activate`;
  const r = await fetch(url, {
    method: 'POST',
    headers: updateFeeHeaders(),
    body: JSON.stringify({ license_key, project_type, confirm: true }),
  });
  const { httpStatus, data } = await parseJsonResponse(r);
  return { httpStatus, data };
}

async function oxapayCreateInvoice(body) {
  const r = await fetch('https://api.oxapay.com/v1/payment/invoice', {
    method: 'POST',
    headers: {
      merchant_api_key: OXAPAY_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json: j };
}

async function oxapayPaymentInfo(track_id) {
  const r = await fetch(`https://api.oxapay.com/v1/payment/${encodeURIComponent(track_id)}`, {
    method: 'GET',
    headers: {
      merchant_api_key: OXAPAY_KEY,
      'Content-Type': 'application/json',
    },
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json: j };
}

function maskLicense(lk) {
  const x = normLicense(lk);
  if (x.length < 12) return '****';
  return `${x.slice(0, 4)}…${x.slice(-4)}`;
}

/** Human label for invoices / logs only — API still uses Quotex / Quotex Low Quality. */
function projectTypeDisplayName(project_type) {
  const m = {
    Quotex: 'Mega X Version',
    'Quotex Low Quality': 'Mega Version',
  };
  return m[project_type] || project_type;
}

function pickPaymentUrl(resJson) {
  const d = resJson?.data || resJson;
  return d?.payment_url || d?.paymentUrl || null;
}

function pickTrackId(resJson) {
  const d = resJson?.data || resJson;
  return d?.track_id != null ? String(d.track_id) : null;
}

function pickOxaStatus(resJson) {
  const d = resJson?.data || resJson;
  const s = d?.status;
  return s != null ? String(s) : '';
}

/**
 * Calls /api/v1/update-fee/pending for each `project_type` (doc §3: only `Quotex` and `Quotex Low Quality`, no aliases).
 * Stops on PENDING_REGISTERED. INVALID_PROJECT / LICENSE_NOT_FOUND / TOKEN_SCOPE_DENIED → try next type.
 */
async function detectProjectAndPending(license_key) {
  let last = null;
  const codes = [];
  for (const project_type of PROJECT_TYPES) {
    const { httpStatus, data } = await licensePending(license_key, project_type);
    last = { httpStatus, data };
    const code = data?.code;
    if (!code) {
      return {
        ok: false,
        code: 'LICENSE_SERVER_RESPONSE',
        httpStatus,
        data,
      };
    }
    codes.push(code);
    if (code === 'PENDING_REGISTERED') {
      return { ok: true, project_type, httpStatus, data };
    }
    if (code === 'MASTER_DISABLED') {
      return { ok: false, code: 'MASTER_DISABLED', httpStatus, data };
    }
    if (code === 'INVALID_TOKEN' || httpStatus === 401) {
      return { ok: false, code: 'LICENSE_SERVER_AUTH', httpStatus, data };
    }
    if (code === 'INVALID_PROJECT' || code === 'LICENSE_NOT_FOUND' || code === 'TOKEN_SCOPE_DENIED') {
      continue;
    }
    return { ok: false, code: code || 'VERIFY_FAILED', httpStatus, data };
  }

  const allNotFound =
    codes.length === PROJECT_TYPES.length && codes.every((c) => c === 'LICENSE_NOT_FOUND');
  if (allNotFound) {
    return { ok: false, code: 'LICENSE_NOT_FOUND', httpStatus: last?.httpStatus, data: last?.data };
  }

  return {
    ok: false,
    code: last?.data?.code || 'INVALID_PROJECT',
    httpStatus: last?.httpStatus,
    data: last?.data,
  };
}

async function tryFulfillOrder(orderId) {
  return withStore(async (store) => {
    const o = store.orders[orderId];
    if (!o) return { ok: false, reason: 'ORDER_NOT_FOUND' };
    if (o.licenseActivated) {
      return { ok: true, already: true, code: o.activationCode, license: o.license_key };
    }

    let paid = o.oxapayPaid === true;
    if (!paid && o.track_id) {
      const info = await oxapayPaymentInfo(o.track_id);
      const st = pickOxaStatus(info.json).toLowerCase();
      paid = st === 'paid' || st === 'completed';
      if (paid) o.oxapayPaid = true;
    }

    if (!paid) return { ok: false, reason: 'NOT_PAID_YET' };

    const act = await licenseActivate(o.license_key, o.project_type);
    const code = act.data?.code;
    if (code === 'ACTIVATED' || code === 'ALREADY_ACTIVE') {
      o.licenseActivated = true;
      o.activationCode = code;
      o.activatedAt = new Date().toISOString();
      return { ok: true, code, license: o.license_key };
    }
    o.lastActivateError = { code, at: new Date().toISOString() };
    return { ok: false, reason: 'ACTIVATE_FAILED', code };
  });
}

let pollPendingInFlight = false;

async function pollPendingPaymentsOnce() {
  if (!OXAPAY_KEY || !LICENSE_BASE || !UPDATE_TOKEN) return;
  const store = await readStore();
  const orders = store.orders || {};
  const now = Date.now();
  for (const orderId of Object.keys(orders)) {
    const o = orders[orderId];
    if (!o || o.licenseActivated || !o.track_id) continue;
    const created = o.createdAt ? Date.parse(o.createdAt) : NaN;
    if (!Number.isFinite(created) || now - created > PENDING_PAYMENT_MAX_ORDER_AGE_MS) continue;
    try {
      await tryFulfillOrder(orderId);
    } catch (e) {
      if (process.env.UPDATE_FEE_DEBUG === '1') {
        // eslint-disable-next-line no-console
        console.warn('[pending-payment-poll]', orderId, e && e.message ? e.message : e);
      }
    }
  }
}

async function pollPendingPaymentsTick() {
  if (pollPendingInFlight) return;
  pollPendingInFlight = true;
  try {
    await pollPendingPaymentsOnce();
  } finally {
    pollPendingInFlight = false;
  }
}

// OxaPay webhook — raw body required for HMAC (docs: sha512 of raw POST)
app.post(
  '/api/webhooks/oxapay',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const postData = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body || '');
    const hmacHeader = (req.get('hmac') || req.get('HMAC') || '').trim();

    let data;
    try {
      data = JSON.parse(postData || '{}');
    } catch {
      res.status(400).send('bad json');
      return;
    }

    const type = data.type;
    if (type !== 'invoice') {
      res.status(200).send('ok');
      return;
    }
    const calculated = crypto.createHmac('sha512', OXAPAY_KEY).update(postData).digest('hex');
    const a = Buffer.from(calculated, 'utf8');
    const b = Buffer.from(String(hmacHeader), 'utf8');
    if (!hmacHeader || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.status(400).send('invalid hmac');
      return;
    }

    const status = String(data.status || '');
    const orderId = data.order_id != null ? String(data.order_id) : '';
    const trackId = data.track_id != null ? String(data.track_id) : '';

    if (type === 'invoice' && orderId && (status === 'Paid' || status.toLowerCase() === 'paid')) {
      await withStore(async (store) => {
        const o = store.orders[orderId];
        if (o) {
          o.oxapayPaid = true;
          if (trackId) o.track_id = trackId;
        }
      });
      await tryFulfillOrder(orderId);
    }

    res.status(200).send('ok');
  }
);

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/verify', async (req, res) => {
  if (!LICENSE_BASE || !UPDATE_TOKEN) {
    res.status(500).json({ ok: false, code: 'SERVER_CONFIG' });
    return;
  }
  const license_key = normLicense(req.body?.license_key);
  if (!license_key) {
    res.json({ ok: false, code: 'MISSING_LICENSE_KEY' });
    return;
  }

  const det = await detectProjectAndPending(license_key);
  if (det.ok) {
    res.json({
      ok: true,
      code: det.data?.code,
      project_type: det.project_type,
      license_mask: maskLicense(license_key),
    });
    return;
  }
  if (det.code === 'LICENSE_NOT_FOUND') {
    res.json({ ok: false, code: 'LICENSE_NOT_FOUND' });
    return;
  }
  if (det.code === 'LICENSE_SERVER_AUTH') {
    res.status(500).json({ ok: false, code: 'LICENSE_SERVER_AUTH' });
    return;
  }
  if (det.code === 'MASTER_DISABLED') {
    res.status(503).json({ ok: false, code: 'MASTER_DISABLED' });
    return;
  }
  const httpStatus = det.httpStatus >= 400 ? det.httpStatus : 400;
  res.status(httpStatus).json({
    ok: false,
    code: det.code || 'VERIFY_FAILED',
    httpStatus: det.httpStatus,
  });
});

app.post('/api/checkout', async (req, res) => {
  if (!LICENSE_BASE || !UPDATE_TOKEN || !OXAPAY_KEY) {
    res.status(500).json({ ok: false, code: 'SERVER_CONFIG' });
    return;
  }
  const license_key = normLicense(req.body?.license_key);
  if (!license_key) {
    res.status(400).json({ ok: false, code: 'BAD_INPUT' });
    return;
  }

  const det = await detectProjectAndPending(license_key);
  if (!det.ok || det.data?.code !== 'PENDING_REGISTERED') {
    res.status(400).json({ ok: false, code: det.code || 'LICENSE_NOT_READY' });
    return;
  }
  const project_type = det.project_type;

  const orderId = `UF-${crypto.randomBytes(12).toString('hex')}`;
  const return_url = `${PUBLIC_URL}/success.html?order=${encodeURIComponent(orderId)}`;
  const callback_url = `${PUBLIC_URL}/api/webhooks/oxapay`;

  const invoiceBody = {
    amount: 9,
    currency: 'USD',
    lifetime: 45,
    fee_paid_by_payer: 0,
    under_paid_coverage: 2.5,
    to_currency: 'USDT',
    auto_withdrawal: false,
    mixed_payment: true,
    return_url,
    callback_url,
    order_id: orderId,
    thanks_message: 'Thank you — your extension update fee is received.',
    description: `Extension update fee — ${maskLicense(license_key)} (${projectTypeDisplayName(project_type)})`,
    sandbox: false,
  };

  const inv = await oxapayCreateInvoice(invoiceBody);
  const paymentUrl = pickPaymentUrl(inv.json);
  const trackId = pickTrackId(inv.json);

  if (!inv.ok || !paymentUrl || !trackId) {
    res.status(502).json({
      ok: false,
      code: 'OXAPAY_INVOICE_FAILED',
      detail: inv.json?.message || inv.json?.error || null,
    });
    return;
  }

  await withStore(async (store) => {
    store.orders[orderId] = {
      license_key,
      project_type,
      track_id: trackId,
      createdAt: new Date().toISOString(),
      oxapayPaid: false,
      licenseActivated: false,
    };
  });

  res.json({
    ok: true,
    order_id: orderId,
    track_id: trackId,
    payment_url: paymentUrl,
  });
});

app.get('/api/order-status', async (req, res) => {
  const orderId = String(req.query.order || '').trim();
  if (!orderId) {
    res.status(400).json({ ok: false, code: 'MISSING_ORDER' });
    return;
  }

  const store0 = await readStore();
  const o0 = store0.orders[orderId];
  if (!o0) {
    res.status(404).json({ ok: false, code: 'ORDER_NOT_FOUND' });
    return;
  }

  if (!o0.licenseActivated) {
    await tryFulfillOrder(orderId);
  }

  const store1 = await readStore();
  const o = store1.orders[orderId];
  if (!o) {
    res.status(404).json({ ok: false, code: 'ORDER_NOT_FOUND' });
    return;
  }

  res.json({
    ok: true,
    found: true,
    oxapayPaid: !!o.oxapayPaid,
    licenseActivated: !!o.licenseActivated,
    activationCode: o.activationCode || null,
    license_mask: maskLicense(o.license_key),
    project_type: o.project_type,
  });
});

app.post('/api/sync-payment', async (req, res) => {
  const orderId = String(req.body?.order_id || '').trim();
  if (!orderId) {
    res.status(400).json({ ok: false, code: 'MISSING_ORDER' });
    return;
  }
  const out = await tryFulfillOrder(orderId);
  res.json(out);
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Update fee site → http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`Public URL (OxaPay): ${PUBLIC_URL}`);
  setInterval(() => {
    void pollPendingPaymentsTick();
  }, PENDING_PAYMENT_POLL_MS);
  setTimeout(() => {
    void pollPendingPaymentsTick();
  }, 5000);
});
