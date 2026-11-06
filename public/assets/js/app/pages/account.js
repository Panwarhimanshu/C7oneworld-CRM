import { http } from '../../http.js';
import { h, mount } from '../dom.js';
import { field, showFieldErrors, withBusy, alertBox, toast } from '../ui.js';

export function passwordForm({ submitLabel = 'Update password', onDone }) {
  const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', maxLength: 128 });
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', maxLength: 128 });
  const confirm = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', maxLength: 128 });
  const errorHost = h('div');
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, submitLabel);

  const form = h('form', { novalidate: true },
    errorHost,
    field({ label: 'Current password', name: 'currentPassword', input: current }),
    field({ label: 'New password', name: 'newPassword', input: next, hint: 'At least 12 characters. Use three of: lowercase, uppercase, numbers, symbols — or 16+ characters.' }),
    field({ label: 'Confirm new password', name: 'confirmPassword', input: confirm }),
    h('div', { class: 'spacer-12' }),
    submit,
  );

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    mount(errorHost);
    showFieldErrors(form, {});
    if (next.value !== confirm.value) {
      showFieldErrors(form, { confirmPassword: 'Passwords do not match.' });
      return;
    }
    withBusy(submit, 'Saving…', async () => {
      try {
        await http.post('/api/auth/change-password', { currentPassword: current.value, newPassword: next.value });
        form.reset();
        onDone?.();
      } catch (err) {
        if (!showFieldErrors(form, err.fields)) mount(errorHost, alertBox('error', err.message), h('div', { class: 'spacer-12' }));
      }
    });
  });
  return form;
}

export function renderAccount(container, ctx) {
  ctx.setHeader('My account');
  const u = ctx.me.user;
  mount(container, h('div', { class: 'page-narrow' },
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', 'Profile')),
      h('div', { class: 'card-body' },
        h('dl', { class: 'props' },
          h('dt', 'Name'), h('dd', u.fullName),
          h('dt', 'Email'), h('dd', u.email),
          h('dt', 'Role'), h('dd', u.roleLabel),
        ),
        h('p', { class: 'hint', style: null }, 'Contact a Super Admin to change your name or role'),
      ),
    ),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', 'Change password')),
      h('div', { class: 'card-body' },
        passwordForm({ onDone: () => toast('Password updated. Other devices have been signed out.') }),
      ),
    ),
  ));
}
