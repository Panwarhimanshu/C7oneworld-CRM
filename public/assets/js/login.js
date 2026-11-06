import { http } from './http.js';

const form = document.getElementById('login-form');
const alertEl = document.getElementById('login-alert');
const pw = document.getElementById('password');

function showAlert(message, kind = 'error') {
  alertEl.className = `alert alert-${kind}`;
  alertEl.textContent = message;
  alertEl.hidden = !message;
}

function fieldError(name, message) {
  const f = form.querySelector(`[data-field="${name}"]`);
  f.classList.toggle('has-error', Boolean(message));
  const p = f.querySelector('.field-error');
  p.textContent = message || '';
  p.hidden = !message;
}

// Only ever redirect inside the staff app (prevents open redirects).
function nextUrl() {
  const next = new URLSearchParams(location.search).get('next') || '';
  // "/app" lets the workspace choose the right home screen for the user's role.
  return /^\/app(\/[A-Za-z0-9\-/]*)?$/.test(next) ? next : '/app';
}

const reason = new URLSearchParams(location.search).get('reason');
if (reason === 'expired') showAlert('Your session ended. Please sign in again.', 'info');
if (reason === 'signed-out') showAlert('You have been signed out.', 'info');

document.getElementById('toggle-pw').addEventListener('click', (e) => {
  const showing = pw.type === 'text';
  pw.type = showing ? 'password' : 'text';
  e.currentTarget.textContent = showing ? 'Show' : 'Hide';
  e.currentTarget.setAttribute('aria-pressed', String(!showing));
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showAlert('');
  fieldError('email', '');
  fieldError('password', '');

  const email = form.email.value.trim();
  const password = form.password.value;
  let bad = false;
  if (!email) { fieldError('email', 'Enter your work email.'); bad = true; }
  if (!password) { fieldError('password', 'Enter your password.'); bad = true; }
  if (bad) return;

  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    await http.post('/api/auth/login', { email, password });
    location.replace(nextUrl());
  } catch (err) {
    if (err.code === 'VALIDATION_FAILED' && err.fields.email) fieldError('email', err.fields.email);
    else showAlert(err.message);
    pw.value = '';
    pw.focus();
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

// Already signed in? Skip the form.
http.get('/api/auth/me').then(() => location.replace(nextUrl())).catch(() => {});
