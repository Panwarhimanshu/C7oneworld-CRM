import { http, ApiError } from './http.js';

const AUTO_RESET_SECONDS = 20;

const $ = (sel) => document.querySelector(sel);
const steps = { details: $('#step-details'), verify: $('#step-verify'), done: $('#step-done'), ended: $('#step-ended') };

const state = {
  options: null,
  requestId: null,
  resendTimer: null,
  resetTimer: null,
};

// ---------------------------------------------------------------- helpers

function show(step) {
  for (const [name, el] of Object.entries(steps)) el.hidden = name !== step;
  const order = ['details', 'verify', 'done'];
  const current = step === 'ended' ? 'details' : step;
  document.querySelectorAll('.reg-steps li').forEach((li) => {
    const idx = order.indexOf(li.dataset.step);
    li.classList.toggle('is-current', li.dataset.step === current);
    li.classList.toggle('is-done', idx < order.indexOf(current));
  });
  window.scrollTo({ top: 0 });
}

function setFieldError(form, name, message) {
  const field = form.querySelector(`[data-field="${name}"]`);
  if (!field) return false;
  const msg = field.querySelector('.field-error');
  field.classList.toggle('has-error', Boolean(message));
  if (msg) {
    msg.textContent = message || '';
    msg.hidden = !message;
  }
  const input = field.querySelector('input:not([type=radio]), select');
  if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
  return true;
}

function clearErrors(form) {
  form.querySelectorAll('[data-field]').forEach((f) => setFieldError(form, f.dataset.field, ''));
}

function showAlert(el, message, kind = 'error') {
  el.className = `alert alert-${kind}`;
  el.textContent = message;
  el.hidden = !message;
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (busy) {
    button.dataset.label = button.textContent;
    button.replaceChildren(Object.assign(document.createElement('span'), { className: 'spinner' }), document.createTextNode(label));
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
}

function endSession(message) {
  state.requestId = null;
  stopResendTimer();
  $('#ended-message').textContent = message;
  show('ended');
}

// ---------------------------------------------------------------- step 1

const detailsForm = $('#details-form');
const detailsError = $('#details-error');

function clientValidate(values) {
  const errors = {};
  if (values.fullName.trim().length < 2) errors.fullName = 'Please enter your full name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email.trim())) errors.email = 'Please enter a valid email address.';
  const digits = values.mobile.replace(/\D/g, '');
  if (values.countryCode === '91' ? !/^(0|91)?[6-9]\d{9}$/.test(digits) : digits.length < 6 || digits.length > 14) {
    errors.mobile = 'Please enter a valid mobile number.';
  }
  return errors;
}

detailsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors(detailsForm);
  showAlert(detailsError, '');

  const fd = new FormData(detailsForm);
  const values = {
    fullName: String(fd.get('fullName') || ''),
    email: String(fd.get('email') || ''),
    countryCode: String(fd.get('countryCode') || ''),
    mobile: String(fd.get('mobile') || ''),
    channel: String(fd.get('channel') || state.options?.channels[0] || 'sms'),
  };
  const company = String(fd.get('company') || '');
  if (company) values.company = company;

  const errors = clientValidate(values);
  if (Object.keys(errors).length) {
    for (const [k, v] of Object.entries(errors)) setFieldError(detailsForm, k, v);
    detailsForm.querySelector('.has-error input, .has-error select')?.focus();
    return;
  }

  const button = detailsForm.querySelector('button[type=submit]');
  setBusy(button, true, 'Sending code…');
  try {
    const res = await http.post('/api/registration', values);
    startVerify(res);
  } catch (err) {
    handleDetailsError(err);
  } finally {
    setBusy(button, false);
  }
});

function handleDetailsError(err) {
  if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
    let placed = false;
    for (const [k, v] of Object.entries(err.fields)) placed = setFieldError(detailsForm, k, v) || placed;
    if (!placed) showAlert(detailsError, err.message);
    return;
  }
  showAlert(detailsError, err.message);
}

// ---------------------------------------------------------------- step 2

const verifyForm = $('#verify-form');
const verifyAlert = $('#verify-alert');
const codeInput = $('#code');
const resendBtn = $('#resend-btn');
const resendTimerEl = $('#resend-timer');

function startVerify(res) {
  state.requestId = res.requestId;
  $('#otp-destination').textContent = res.destination;
  $('#otp-length').textContent = String(state.options?.otpLength || 6);
  codeInput.maxLength = state.options?.otpLength || 6;
  codeInput.value = '';
  clearErrors(verifyForm);
  showAlert(verifyAlert, state.options?.devBypassCode ? `Development mode: use code ${state.options.devBypassCode}` : '', 'warning');
  show('verify');
  codeInput.focus();
  startResendTimer(res.resendIn, res.resendsLeft);
}

function stopResendTimer() {
  clearInterval(state.resendTimer);
  state.resendTimer = null;
}

function startResendTimer(seconds, resendsLeft) {
  stopResendTimer();
  if (resendsLeft <= 0) {
    resendBtn.disabled = true;
    resendBtn.hidden = true;
    resendTimerEl.textContent = '';
    $('#resend-label').textContent = 'No more resends are available for this registration.';
    return;
  }
  resendBtn.hidden = false;
  $('#resend-label').textContent = "Didn't receive the code?";
  let left = seconds;
  const tick = () => {
    if (left <= 0) {
      stopResendTimer();
      resendBtn.disabled = false;
      resendTimerEl.textContent = '';
      return;
    }
    resendBtn.disabled = true;
    resendTimerEl.textContent = `in 0:${String(left).padStart(2, '0')}`;
    left -= 1;
  };
  tick();
  state.resendTimer = setInterval(tick, 1000);
}

codeInput.addEventListener('input', () => {
  const max = state.options?.otpLength || 6;
  codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, max);
  if (codeInput.value.length === max) verifyForm.requestSubmit();
});

verifyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors(verifyForm);
  const code = codeInput.value.trim();
  const max = state.options?.otpLength || 6;
  if (code.length !== max) {
    setFieldError(verifyForm, 'code', `Enter the ${max}-digit code.`);
    return;
  }

  if (state.verifying) return;
  state.verifying = true;
  const button = verifyForm.querySelector('button[type=submit]');
  setBusy(button, true, 'Verifying…');
  try {
    const res = await http.post('/api/registration/verify', { requestId: state.requestId, code });
    complete(res);
  } catch (err) {
    handleVerifyError(err);
  } finally {
    state.verifying = false;
    setBusy(button, false);
  }
});

function handleVerifyError(err) {
  codeInput.select();
  switch (err.code) {
    case 'OTP_INVALID': {
      const n = err.data.attemptsRemaining;
      showAlert(verifyAlert, `${err.message} You have ${n} attempt${n === 1 ? '' : 's'} left. Re-enter the code, or request a new one.`);
      break;
    }
    case 'OTP_EXPIRED':
      showAlert(verifyAlert, err.data.canResend ? `${err.message}` : 'This code has expired. Please start again.', 'warning');
      if (!err.data.canResend) endSession('Your verification code expired. Please enter your details again to receive a new one.');
      break;
    case 'OTP_LOCKED':
      endSession('The code was entered incorrectly too many times. For your security, please enter your details again to receive a new code.');
      break;
    case 'SESSION_ENDED':
      endSession(err.message);
      break;
    default:
      showAlert(verifyAlert, err.message);
  }
}

resendBtn.addEventListener('click', async () => {
  showAlert(verifyAlert, '');
  resendBtn.disabled = true;
  try {
    const res = await http.post('/api/registration/resend', { requestId: state.requestId });
    codeInput.value = '';
    codeInput.focus();
    showAlert(verifyAlert, `A new code has been sent to ${res.destination}. Previous codes no longer work.`, 'info');
    startResendTimer(res.resendIn, res.resendsLeft);
  } catch (err) {
    if (err.code === 'SESSION_ENDED') return endSession(err.message);
    if (err.code === 'RESEND_COOLDOWN') return startResendTimer(err.data.retryAfter || 30, 1);
    showAlert(verifyAlert, err.message);
    if (err.code === 'RESEND_LIMIT') startResendTimer(0, 0);
    else resendBtn.disabled = false;
  }
});

$('#change-details').addEventListener('click', () => {
  state.requestId = null;
  stopResendTimer();
  show('details');
  $('#mobile').focus();
});

// ---------------------------------------------------------------- step 3

function complete(res) {
  state.requestId = null;
  stopResendTimer();
  $('#done-title').textContent = res.firstName ? `Thank you for registering, ${res.firstName}` : 'Thank you for registering';
  show('done');

  // Reset automatically so a shared reception tablet never shows the previous visitor.
  let left = AUTO_RESET_SECONDS;
  const resetEl = $('#done-reset');
  const tick = () => {
    resetEl.textContent = `This screen will reset in ${left} seconds.`;
    if (left-- <= 0) resetForm();
  };
  tick();
  state.resetTimer = setInterval(tick, 1000);
}

function resetForm() {
  clearInterval(state.resetTimer);
  stopResendTimer();
  state.requestId = null;
  detailsForm.reset();
  if (state.options) $('#countryCode').value = state.options.defaultCountryCode;
  clearErrors(detailsForm);
  clearErrors(verifyForm);
  showAlert(detailsError, '');
  showAlert(verifyAlert, '');
  show('details');
  $('#fullName').focus();
}

$('#new-registration').addEventListener('click', resetForm);
$('#restart').addEventListener('click', resetForm);

// ---------------------------------------------------------------- init

(async function init() {
  try {
    const opts = await http.get('/api/registration/options');
    state.options = opts;
    document.querySelectorAll('[data-org-name]').forEach((el) => { el.textContent = opts.orgName; });
    document.title = `Visitor Registration · ${opts.orgName}`;

    const cc = $('#countryCode');
    if (![...cc.options].some((o) => o.value === opts.defaultCountryCode)) {
      cc.prepend(new Option(`+${opts.defaultCountryCode}`, opts.defaultCountryCode));
    }
    cc.value = opts.defaultCountryCode;

    const channelField = document.querySelector('[data-field="channel"]');
    if (opts.channels.length > 1) {
      channelField.hidden = false;
    } else {
      channelField.querySelectorAll('input').forEach((i) => { i.checked = i.value === opts.channels[0]; });
    }
  } catch {
    showAlert(detailsError, 'Registration is temporarily unavailable. Please ask the reception desk for help.');
  }
})();
