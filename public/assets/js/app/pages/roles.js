import { http } from '../../http.js';
import { h, icon, mount } from '../dom.js';
import { alertBox, openModal, confirmModal, field, showFieldErrors, withBusy, toast } from '../ui.js';
import { permissionList } from '../permissionList.js';

export function renderRoles(container, ctx) {
  const state = { roles: [], catalog: [], selected: null, dirty: false };

  const newBtn = h('button', { class: 'btn btn-primary', type: 'button', onClick: () => editRole(null) }, icon('plus'), 'New role');
  ctx.setHeader('Roles & permissions', { actions: [newBtn] });

  const listHost = h('nav', { class: 'role-list', 'aria-label': 'Roles' });
  const editorHost = h('div', { class: 'role-editor card' });
  mount(container,
    h('p', { class: 'page-intro' }, 'A role decides which menus a login sees and what it can do. Changes apply to every login in the role on their next action, without signing out.'),
    h('div', { class: 'roles-layout' }, h('div', { class: 'card role-list-card' }, listHost), editorHost),
  );

  async function load(selectKey) {
    try {
      const data = await http.get('/api/roles');
      state.roles = data.roles;
      state.catalog = data.catalog;
      const key = selectKey || state.selected || data.roles.find((r) => !r.isLocked)?.key || data.roles[0].key;
      select(key, { force: true });
    } catch (err) {
      mount(container, alertBox('error', err.message));
    }
  }

  async function select(key, { force = false } = {}) {
    if (!force && state.dirty && key !== state.selected) {
      const ok = await confirmModal({ title: 'Discard changes?', message: 'You have unsaved permission changes for this role.', confirmLabel: 'Discard', danger: true });
      if (!ok) return;
    }
    state.selected = key;
    state.dirty = false;
    renderList();
    renderEditor();
  }

  function renderList() {
    mount(listHost, state.roles.map((r) => h('button', {
      type: 'button',
      class: ['role-item', r.key === state.selected && 'is-active'],
      'aria-current': r.key === state.selected ? 'true' : null,
      onClick: () => select(r.key),
    },
      h('span', { class: 'role-item-name' }, r.name, r.isLocked ? icon('lock', 12) : null),
      h('span', { class: 'role-item-meta' }, `${r.userCount} login${r.userCount === 1 ? '' : 's'} · ${r.isLocked ? 'Full access' : `${r.permissions.length} permission${r.permissions.length === 1 ? '' : 's'}`}`),
    )));
  }

  function renderEditor() {
    const role = state.roles.find((r) => r.key === state.selected);
    if (!role) return mount(editorHost);

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Save changes');
    const discardBtn = h('button', { class: 'btn', type: 'button', disabled: true }, 'Discard');
    const status = h('span', { class: 'muted' }, role.isLocked ? 'Super Admin always has full access.' : 'No unsaved changes');

    const list = permissionList({
      catalog: state.catalog,
      selected: role.permissions,
      locked: role.isLocked,
      isDisabled: (p) => (p.restricted ? 'Super Admin only' : null),
      onChange: (set) => {
        state.dirty = !sameSet(set, new Set(role.permissions));
        saveBtn.disabled = !state.dirty;
        discardBtn.disabled = !state.dirty;
        status.textContent = state.dirty ? 'Unsaved changes' : 'No unsaved changes';
        status.className = state.dirty ? 'unsaved' : 'muted';
      },
    });

    discardBtn.addEventListener('click', () => select(role.key, { force: true }));
    saveBtn.addEventListener('click', () => withBusy(saveBtn, 'Saving…', async () => {
      try {
        await http.put(`/api/roles/${role.key}/permissions`, { permissions: [...list.value()] });
        toast(`Permissions saved for ${role.name}.`);
        state.dirty = false;
        await load(role.key);
      } catch (err) {
        toast(err.message, { kind: 'error' });
      }
    }));

    mount(editorHost,
      h('div', { class: 'card-head role-head' },
        h('div', null,
          h('h2', role.name, ' ', h('span', { class: 'tag' }, role.isLocked ? 'Locked' : role.isSystem ? 'Built-in' : 'Custom')),
          h('p', { class: 'muted' }, role.description || 'No description.'),
        ),
        h('div', { class: 'spacer' }),
        role.isLocked ? null : h('button', { class: 'btn btn-sm', type: 'button', onClick: () => editRole(role) }, 'Rename'),
        role.isSystem ? null : h('button', { class: 'btn btn-sm btn-danger', type: 'button', onClick: () => deleteRole(role) }, icon('trash', 14), 'Delete'),
      ),
      h('div', { class: 'card-body' }, list.el),
      role.isLocked ? null : h('div', { class: 'role-foot' }, status, h('div', { class: 'spacer' }), discardBtn, saveBtn),
    );
  }

  function editRole(role) {
    const isNew = !role;
    const name = h('input', { class: 'input', value: role?.name || '', maxLength: 60, autocomplete: 'off', placeholder: 'e.g. IELTS Department' });
    const desc = h('input', { class: 'input', value: role?.description || '', maxLength: 200, autocomplete: 'off', placeholder: 'What this role is for' });
    const copy = h('select', { class: 'select' },
      h('option', { value: '' }, 'Start with no permissions'),
      state.roles.filter((r) => !r.isLocked).map((r) => h('option', { value: r.key }, `Copy from ${r.name}`)));
    const form = h('form', { novalidate: true },
      field({ label: 'Role name', name: 'name', input: name }),
      field({ label: 'Description', name: 'description', input: desc }),
      isNew ? field({ label: 'Starting permissions', name: 'copyFrom', input: copy, hint: 'You can fine-tune them after the role is created.' }) : null,
    );
    const save = h('button', { class: 'btn btn-primary', type: 'button' }, isNew ? 'Create role' : 'Save');
    const { close } = openModal({
      title: isNew ? 'New role' : `Rename ${role.name}`,
      description: isNew ? 'Create a role for a department or team, e.g. IELTS, Visa or Accounts.' : null,
      body: form,
      actions: ({ close }) => [h('button', { class: 'btn', type: 'button', onClick: close }, 'Cancel'), save],
    });
    const submit = () => withBusy(save, 'Saving…', async () => {
      try {
        if (isNew) {
          const body = { name: name.value, description: desc.value };
          if (copy.value) body.copyFrom = copy.value;
          const created = await http.post('/api/roles', body);
          close();
          toast(`Role “${created.name}” created.`);
          await load(created.key);
        } else {
          await http.patch(`/api/roles/${role.key}`, { name: name.value, description: desc.value });
          close();
          await load(role.key);
        }
      } catch (err) {
        if (!showFieldErrors(form, err.fields)) toast(err.message, { kind: 'error' });
      }
    });
    save.addEventListener('click', submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  }

  async function deleteRole(role) {
    if (role.userCount > 0) {
      toast(`Move the ${role.userCount} login${role.userCount === 1 ? '' : 's'} in “${role.name}” to another role first.`, { kind: 'error' });
      return;
    }
    const ok = await confirmModal({ title: `Delete “${role.name}”?`, message: 'This role will be removed permanently.', confirmLabel: 'Delete role', danger: true });
    if (!ok) return;
    try {
      await http.del(`/api/roles/${role.key}`);
      toast('Role deleted.');
      state.selected = null;
      await load();
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  }

  load().then(() => { if (history.state?.open === 'new') { history.replaceState(null, ''); editRole(null); } });
}

function sameSet(a, b) {
  return a.size === b.size && [...a].every((x) => b.has(x));
}
