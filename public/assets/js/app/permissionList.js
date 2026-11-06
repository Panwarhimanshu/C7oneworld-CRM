import { h, icon, mount } from './dom.js';

// Grouped checklist of permissions with dependency handling:
// ticking an item ticks what it needs; unticking an item unticks what depends on it.
export function permissionList({ catalog, selected, locked = false, isDisabled = () => null, describe = () => null, onChange = () => {} }) {
  const byKey = new Map(catalog.map((p) => [p.key, p]));
  const set = new Set(selected);
  const root = h('div', { class: 'perm-list' });

  function check(key) {
    if (set.has(key)) return;
    set.add(key);
    const p = byKey.get(key);
    p.requires.forEach(check);
    if (p.requiresAny.length && !p.requiresAny.some((r) => set.has(r))) check(p.requiresAny[0]);
  }

  function uncheck(key) {
    if (!set.has(key)) return;
    set.delete(key);
    for (const p of catalog) {
      if (!set.has(p.key)) continue;
      if (p.requires.includes(key)) uncheck(p.key);
      else if (p.requiresAny.length && !p.requiresAny.some((r) => set.has(r))) uncheck(p.key);
    }
  }

  function needs(p) {
    const parts = [];
    if (p.requires.length) parts.push(`Needs ${p.requires.map((r) => byKey.get(r).label).join(', ')}`);
    if (p.requiresAny.length) parts.push(`Needs ${p.requiresAny.map((r) => byKey.get(r).label).join(' or ')}`);
    return parts.join(' · ');
  }

  function render() {
    const groups = [...new Set(catalog.map((p) => p.group))];
    mount(root, groups.map((g) => h('section', { class: 'perm-group' },
      h('h3', g),
      catalog.filter((p) => p.group === g).map((p) => {
        const reason = locked ? 'Super Admin always has this' : isDisabled(p);
        const id = `perm-${p.key.replace('.', '-')}`;
        const box = h('input', {
          type: 'checkbox', id, checked: set.has(p.key), disabled: Boolean(reason),
          onChange: () => {
            if (box.checked) check(p.key);
            else uncheck(p.key);
            render();
            onChange(new Set(set));
          },
        });
        return h('label', { class: ['perm-row', reason && 'is-disabled'], htmlFor: id },
          box,
          h('span', { class: 'perm-text' },
            h('span', { class: 'perm-title' },
              p.label,
              p.menu ? h('span', { class: 'tag tag-brand' }, `Menu: ${p.menu}`) : null,
              p.restricted ? h('span', { class: 'tag' }, icon('lock', 11), ' Super Admin only') : null,
            ),
            h('span', { class: 'perm-desc' }, p.description),
            needs(p) ? h('span', { class: 'perm-needs' }, needs(p)) : null,
          ),
          describe(p, set.has(p.key)),
        );
      }),
    )));
  }

  render();
  return { el: root, value: () => new Set(set), reset(next) { set.clear(); next.forEach((k) => set.add(k)); render(); } };
}
