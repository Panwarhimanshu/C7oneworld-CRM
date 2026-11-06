import { http } from '../../http.js';
import { h, icon, mount, fmt } from '../dom.js';
import { alertBox, openModal, confirmModal, field, showFieldErrors, withBusy, toast, secretBox } from '../ui.js';
import { permissionList } from '../permissionList.js';

export function renderUsers(container, ctx) {
  const state = { items: [], roles: [], roleFilter: 'all', q: '' };

  const addBtn = h('button', { class: 'btn btn-primary', type: 'button', onClick: () => editUser(null) }, icon('plus'), 'New login');
  ctx.setHeader('Logins', { actions: [addBtn] });

  const search = h('input', {
    class: 'input', type: 'search', placeholder: 'Search name or email', 'aria-label': 'Search logins',
    onInput: () => { state.q = search.value.trim().toLowerCase(); renderTable(); },
  });
  const roleFilter = h('select', { class: 'select', 'aria-label': 'Role', onChange: () => { state.roleFilter = roleFilter.value; renderTable(); } });
  const summary = h('span', { class: 'muted' });
  const host = h('div', { class: 'card' });
  mount(container,
    h('div', { class: 'toolbar' }, h('div', { class: 'search' }, icon('search', 15), search), roleFilter, h('div', { class: 'spacer' }), summary),
    host,
  );

  async function load() {
    try {
      const data = await http.get('/api/users');
      state.items = data.items;
      state.roles = data.roles;
      mount(roleFilter, h('option', { value: 'all' }, 'All roles'), data.roles.map((r) => h('option', { value: r.key }, r.name)));
      roleFilter.value = state.roles.some((r) => r.key === state.roleFilter) ? state.roleFilter : 'all';
      renderTable();
    } catch (err) {
      mount(host, h('div', { class: 'card-body' }, alertBox('error', err.message)));
    }
  }

  function statusTag(u) {
    if (!u.isActive) return h('span', { class: 'tag' }, 'Inactive');
    if (u.isLocked) return h('span', { class: 'tag tag-danger' }, 'Locked out');
    if (u.mustChangePassword) return h('span', { class: 'tag tag-warning' }, 'Pending first sign-in');
    return h('span', { class: 'tag tag-success' }, 'Active');
  }

  function renderTable() {
    const isSelf = (u) => u.id === ctx.me.user.id;
    const items = state.items.filter((u) =>
      (state.roleFilter === 'all' || u.role === state.roleFilter)
      && (!state.q || u.fullName.toLowerCase().includes(state.q) || u.email.toLowerCase().includes(state.q)));
    summary.textContent = `${items.length} login${items.length === 1 ? '' : 's'}`;

    if (!items.length) {
      mount(host, h('div', { class: 'empty' }, h('strong', 'No logins match these filters.')));
      return;
    }
    mount(host, h('div', { class: 'table-wrap' },
      h('table', { class: 'data' },
        h('thead', h('tr', h('th', 'Name'), h('th', 'Role'), h('th', 'Status'), h('th', { class: 'hide-sm' }, 'Last sign-in'), h('th', h('span', { class: 'sr-only' }, 'Actions')))),
        h('tbody', items.map((u) => h('tr', null,
          h('td', null, h('div', { class: 'lead-cell' },
            h('span', { class: 'avatar-sm', 'aria-hidden': 'true' }, fmt.initials(u.fullName)),
            h('div', null,
              h('span', { class: 'primary' }, u.fullName), isSelf(u) ? h('span', { class: 'tag tag-self' }, 'You') : null,
              h('span', { class: 'sub' }, u.email),
            ),
          )),
          h('td', null, u.roleName, u.customPermissions ? h('span', { class: 'tag tag-brand tag-self', title: 'This login has access that differs from its role' }, `+${u.customPermissions} custom`) : null),
          h('td', null, statusTag(u)),
          h('td', { class: 'hide-sm nowrap' }, u.lastLoginAt ? fmt.dateTime(u.lastLoginAt) : h('span', { class: 'muted' }, 'Never')),
          h('td', null, h('div', { class: 'row-actions' },
            h('button', { class: 'btn btn-sm', type: 'button', onClick: () => editUser(u) }, 'Edit'),
            state.roles.find((r) => r.key === u.role)?.isLocked ? null
              : h('button', { class: 'btn btn-sm', type: 'button', onClick: () => editAccess(u) }, 'Access'),
            isSelf(u) ? null : h('button', { class: 'btn btn-sm', type: 'button', onClick: () => resetPassword(u) }, 'Reset password'),
          )),
        ))),
      ),
    ));
  }

  function editUser(user) {
    const isNew = !user;
    const isSelf = user && user.id === ctx.me.user.id;
    const name = h('input', { class: 'input', value: user?.fullName || '', maxLength: 100, autocomplete: 'off' });
    const email = h('input', { class: 'input', type: 'email', value: user?.email || '', maxLength: 254, autocomplete: 'off', disabled: !isNew });
    const defaultRole = user?.role || state.roles.find((r) => r.key === 'counselor')?.key || state.roles[0]?.key;
    const role = h('select', { class: 'select', disabled: isSelf },
      state.roles.map((r) => h('option', { value: r.key, selected: defaultRole === r.key }, r.name)));
    const active = h('input', { type: 'checkbox', checked: user ? user.isActive : true, disabled: isSelf, id: 'f-active' });

    const form = h('form', { novalidate: true },
      field({ label: 'Full name', name: 'fullName', input: name }),
      field({ label: 'Work email', name: 'email', input: email, hint: isNew ? 'Used to sign in.' : 'Email cannot be changed. Create a new login instead.' }),
      field({ label: 'Role', name: 'role', input: role, hint: isSelf ? 'You cannot change your own role.' : 'Menus and permissions come from the role. Adjust one person with Access.' }),
      isNew ? null : h('div', { class: 'field' },
        h('label', { class: 'label', htmlFor: 'f-active' }, active, ' Login active'),
        h('p', { class: 'hint' }, isSelf ? 'You cannot deactivate your own login.' : 'Inactive logins cannot sign in. Their history and leads are kept.'),
      ),
      !isNew && user.customPermissions ? h('p', { class: 'hint' }, 'Changing the role clears this login’s custom access') : null,
    );

    const save = h('button', { class: 'btn btn-primary', type: 'button' }, isNew ? 'Create login' : 'Save changes');
    const { close } = openModal({
      title: isNew ? 'New login' : `Edit ${user.fullName}`,
      description: isNew ? 'A temporary password is generated. The person must change it at first sign-in.' : null,
      body: form,
      actions: ({ close }) => [h('button', { class: 'btn', type: 'button', onClick: close }, 'Cancel'), save],
    });

    const submit = () => withBusy(save, 'Saving…', async () => {
      try {
        if (isNew) {
          const res = await http.post('/api/users', { fullName: name.value, email: email.value, role: role.value });
          close();
          showTempPassword(res.user, res.temporaryPassword);
        } else {
          const body = { fullName: name.value };
          if (!isSelf) Object.assign(body, { role: role.value, isActive: active.checked });
          await http.patch(`/api/users/${user.id}`, body);
          close();
          toast('Login updated.');
        }
        load();
      } catch (err) {
        if (!showFieldErrors(form, err.fields)) toast(err.message, { kind: 'error' });
      }
    });
    save.addEventListener('click', submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  }

  async function editAccess(user) {
    let data;
    try {
      data = await http.get(`/api/users/${user.id}/permissions`);
    } catch (err) {
      toast(err.message, { kind: 'error' });
      return;
    }
    const roleSet = new Set(data.rolePermissions);
    const changedCount = h('span', { class: 'muted' });

    const describe = (p, on) => {
      const fromRole = roleSet.has(p.key);
      if (on === fromRole) return h('span', { class: 'perm-source' }, fromRole ? 'From role' : '');
      return h('span', { class: ['perm-source', on ? 'is-added' : 'is-removed'] }, on ? 'Added for this login' : 'Removed for this login');
    };

    const list = permissionList({
      catalog: data.catalog,
      selected: data.effective,
      isDisabled: (p) => (p.restricted ? 'Super Admin only' : null),
      describe,
      onChange: (set) => updateCount(set),
    });
    function updateCount(set) {
      const n = data.catalog.filter((p) => !p.restricted && set.has(p.key) !== roleSet.has(p.key)).length;
      changedCount.textContent = n ? `${n} change${n === 1 ? '' : 's'} from the ${user.roleName} role` : `Same as the ${user.roleName} role`;
    }
    updateCount(new Set(data.effective));

    const save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Save access');
    const resetBtn = h('button', { class: 'btn', type: 'button', onClick: () => { list.reset(roleSet); updateCount(roleSet); } }, 'Reset to role');
    const { dialog, close } = openModal({
      title: `Access for ${user.fullName}`,
      description: `Starts from the ${user.roleName} role. Changes here apply to this login only.`,
      body: list.el,
      actions: ({ close }) => [changedCount, h('div', { class: 'spacer' }), resetBtn, h('button', { class: 'btn', type: 'button', onClick: close }, 'Cancel'), save],
    });
    dialog.classList.add('modal-wide');

    save.addEventListener('click', () => withBusy(save, 'Saving…', async () => {
      const set = list.value();
      const overrides = {};
      for (const p of data.catalog) {
        if (p.restricted) continue;
        if (set.has(p.key) !== roleSet.has(p.key)) overrides[p.key] = set.has(p.key);
      }
      try {
        await http.put(`/api/users/${user.id}/permissions`, { overrides });
        close();
        toast(`Access updated for ${user.fullName}.`);
        load();
      } catch (err) {
        toast(err.message, { kind: 'error' });
      }
    }));
  }

  async function resetPassword(u) {
    const ok = await confirmModal({
      title: `Reset password for ${u.fullName}?`,
      message: 'Their current password stops working immediately and they are signed out of all devices.',
      confirmLabel: 'Reset password',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await http.post(`/api/users/${u.id}/reset-password`);
      showTempPassword(u, res.temporaryPassword);
      load();
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  }

  load().then(() => { if (history.state?.open === 'new') { history.replaceState(null, ''); editUser(null); } });
}

function showTempPassword(user, password) {
  openModal({
    title: 'Temporary password',
    description: `For ${user.fullName} (${user.email})`,
    body: [
      h('p', 'Share this password with the person through a private channel. It is shown only once and must be changed at first sign-in.'),
      secretBox(password),
    ],
    actions: ({ close }) => [h('button', { class: 'btn btn-primary', type: 'button', onClick: close }, 'Done')],
  });
}
