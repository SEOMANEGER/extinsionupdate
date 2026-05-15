const $ = (id) => document.getElementById(id);

const elLicense = $('license');
const elAlert = $('alert');
const elBtnVerify = $('btnVerify');
const elBtnReset = $('btnReset');
const elBtnPay = $('btnPay');
const elBtnHowToPay = $('btnHowToPay');
const elMainCard = $('mainCard');
const elPanelVerify = $('panelVerify');
const elPanelPay = $('panelPay');
const modalBackdrop = $('modalBackdrop');
const modalContinue = $('modalContinue');
const modalClose = $('modalClose');
const modalText = $('modalText');

let verified = false;

function showAlert(text) {
  elAlert.textContent = text;
  elAlert.classList.add('show');
}

function hideAlert() {
  elAlert.textContent = '';
  elAlert.classList.remove('show');
}

function setVerifyLoading(on) {
  elBtnVerify.classList.toggle('is-loading', on);
  elBtnVerify.setAttribute('aria-busy', on ? 'true' : 'false');
  if (elMainCard) elMainCard.classList.toggle('is-verify-loading', on);
  const t = elBtnVerify.querySelector('.btn__text');
  if (t) t.textContent = on ? 'Checking…' : 'Verify';
  elLicense.disabled = on;
  elBtnVerify.disabled = on;
  elBtnPay.disabled = on;
  if (elBtnReset.style.display !== 'none') elBtnReset.disabled = on;
}

function setPayLoading(on, phase) {
  elBtnPay.classList.toggle('is-loading', on);
  elBtnPay.setAttribute('aria-busy', on ? 'true' : 'false');
  if (elMainCard) elMainCard.classList.toggle('is-pay-loading', on);
  const t = elBtnPay.querySelector('.btn__text');
  if (t) {
    if (!on) t.textContent = 'Pay $9';
    else if (phase === 'redirect') t.textContent = 'Redirecting…';
    else t.textContent = 'Opening checkout…';
  }
  elBtnPay.disabled = on;
  elBtnVerify.disabled = on;
  elLicense.disabled = on;
  if (elBtnReset.style.display !== 'none') elBtnReset.disabled = on;
}

function openModal(verifyData) {
  if (modalText) {
    const p = verifyData?.project_type;
    const label = typeof window.projectLabel === 'function' ? window.projectLabel(p) : p;
    modalText.textContent = p ? `OK · ${label}` : 'OK';
  }
  modalBackdrop.classList.add('show');
  modalContinue.focus();
}

function closeModal() {
  modalBackdrop.classList.remove('show');
}

function setStep2() {
  verified = true;
  elPanelVerify.style.display = 'none';
  elPanelPay.style.display = 'block';
  elBtnReset.style.display = 'inline-flex';
}

function resetFlow() {
  verified = false;
  elPanelVerify.style.display = 'block';
  elPanelPay.style.display = 'none';
  elBtnReset.style.display = 'none';
  setVerifyLoading(false);
  setPayLoading(false);
  hideAlert();
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

elBtnVerify.addEventListener('click', async () => {
  hideAlert();
  const license_key = elLicense.value;
  setVerifyLoading(true);
  try {
    const { ok, data } = await postJson('/api/verify', { license_key });
    if (ok && data?.ok && data?.code === 'PENDING_REGISTERED') {
      openModal(data);
      return;
    }
    if (data?.code === 'LICENSE_NOT_FOUND') {
      showAlert('License not found. Use the same key as in your extension, then try again.');
      return;
    }
    if (data?.code === 'MASTER_DISABLED') {
      showAlert('Update fee is temporarily disabled on the license server. Please try again later.');
      return;
    }
    if (data?.code === 'LICENSE_SERVER_AUTH') {
      showAlert('This payment site is misconfigured (license server auth). Please contact support.');
      return;
    }
    if (data?.code === 'INVALID_PROJECT') {
      showAlert('This license could not be verified. Check the key or contact support.');
      return;
    }
    if (data?.code === 'LICENSE_SERVER_RESPONSE') {
      showAlert('Verification service returned an unexpected response. Please try again later.');
      return;
    }
    showAlert(`Could not verify right now (${data?.code || 'unknown'}). Please try again.`);
  } finally {
    setVerifyLoading(false);
  }
});

modalContinue.addEventListener('click', () => {
  closeModal();
  setStep2();
});

modalClose.addEventListener('click', () => {
  closeModal();
});

modalBackdrop.addEventListener('click', (e) => {
  if (e.target === modalBackdrop) closeModal();
});

elBtnReset.addEventListener('click', () => {
  resetFlow();
});

elBtnPay.addEventListener('click', async () => {
  hideAlert();
  const license_key = elLicense.value;
  setPayLoading(true);
  try {
    const { ok, data } = await postJson('/api/checkout', { license_key });
    if (!ok || !data?.ok || !data?.payment_url) {
      showAlert(`Checkout failed (${data?.code || 'unknown'}). Please try again.`);
      setPayLoading(false);
      return;
    }
    setPayLoading(true, 'redirect');
    window.location.assign(data.payment_url);
  } catch {
    showAlert('Could not start checkout. Please try again.');
    setPayLoading(false);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

const HOW_TO_PAY_WEB = 'https://youtu.be/QICMRmET7vY?si=quPD9KNt-_KVFCPa';
const HOW_TO_PAY_VIDEO_ID = 'QICMRmET7vY';

function openHowToPay(e) {
  if (e) e.preventDefault();
  const ua = navigator.userAgent || '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  if (!mobile) {
    window.open(HOW_TO_PAY_WEB, '_blank', 'noopener,noreferrer');
    return;
  }
  const fallback = () => {
    window.open(HOW_TO_PAY_WEB, '_blank', 'noopener,noreferrer');
  };
  const timer = setTimeout(fallback, 1100);
  const cancel = () => clearTimeout(timer);
  window.addEventListener('blur', cancel, { once: true, passive: true });
  window.addEventListener('pagehide', cancel, { once: true, passive: true });

  if (/Android/i.test(ua)) {
    const enc = encodeURIComponent(HOW_TO_PAY_WEB);
    window.location.href = `intent://www.youtube.com/watch?v=${HOW_TO_PAY_VIDEO_ID}#Intent;scheme=https;package=com.google.android.youtube;S.browser_fallback_url=${enc};end`;
  } else {
    window.location.href = `youtube://watch?v=${HOW_TO_PAY_VIDEO_ID}`;
  }
}

if (elBtnHowToPay) {
  elBtnHowToPay.addEventListener('click', openHowToPay);
}
