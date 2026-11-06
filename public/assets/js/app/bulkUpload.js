import { http } from '../http.js';
import { h, icon, mount } from './dom.js';
import { openModal, toast, SOURCE_LABELS, NEW_LEAD_SOURCES } from './ui.js';

const MAX_BYTES = 2 * 1024 * 1024;
const PREVIEW_LIMIT = 300;

const TEMPLATE = [
  'Full name,Country code,Mobile,Email,Source,Assign to (login email),Note',
  'Priya Sharma,91,9876543210,priya@example.com,Referral,,Interested in IELTS weekend batch',
  'Rohan Mehta,91,9123456789,,Phone call,,',
].join('\r\n');

// Bulk upload of leads from CSV (Super Admin). Step 1 choose file -> step 2 preview -> step 3 done.
export function openBulkUpload(ctx, { onDone } = {}) {
  const host = h('div', { class: 'bu' });
  const { dialog, close } = openModal({
    title: 'Bulk upload leads',
    description: 'Add many leads at once from a CSV file. Nothing is saved until you confirm the import.',
    body: host,
    actions: () => [],
  });
  dialog.classList.add('modal-wide', 'modal-bulk');

  const state = { file: null, csv: '', defaultSource: 'bulk_upload', defaultAssigneeId: '', skipDuplicates: true, preview: null, assignees: [] };
  http.get('/api/assignees').then((r) => { state.assignees = r.items; if (!state.preview) renderChoose(); }).catch(() => {});

  // ---------------------------------------------------------------- step 1
  function renderChoose(error) {
    const fileInput = h('input', { type: 'file', accept: '.csv,text/csv', class: 'sr-only', id: 'bu-file' });
    const drop = h('label', { class: ['bu-drop', state.file && 'has-file'], htmlFor: 'bu-file' },
      icon(state.file ? 'check' : 'upload', 22),
      state.file
        ? h('span', null, h('strong', state.file.name), h('span', { class: 'muted' }, ` · ${(state.file.size / 1024).toFixed(1)} KB · click to choose another file`))
        : h('span', null, h('strong', 'Choose a CSV file'), h('span', { class: 'muted' }, ' or drag it here')),
    );
    const pick = (file) => {
      if (!file) return;
      if (!/\.csv$/i.test(file.name)) return renderChoose('Please choose a .csv file. In Excel use File → Save As → CSV.');
      if (file.size > MAX_BYTES) return renderChoose('The file is larger than 2 MB. Split it into smaller files.');
      const reader = new FileReader();
      reader.onload = () => { state.file = file; state.csv = String(reader.result || ''); renderChoose(); };
      reader.onerror = () => renderChoose('The file could not be read.');
      reader.readAsText(file);
    };
    fileInput.addEventListener('change', () => pick(fileInput.files[0]));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-over'); pick(e.dataTransfer.files[0]); });

    const source = h('select', { class: 'select', id: 'bu-source' },
      NEW_LEAD_SOURCES.map((v) => h('option', { value: v, selected: state.defaultSource === v }, SOURCE_LABELS[v])));
    source.addEventListener('change', () => { state.defaultSource = source.value; });
    source.addEventListener('change', () => { state.defaultSource = source.value; });

    const assignee = h('select', { class: 'select', id: 'bu-assignee' }, h('option', { value: '' }, 'Leave unassigned'),
      [...new Set(state.assignees.map((a) => a.roleName))].map((r) => h('optgroup', { label: r },
        state.assignees.filter((a) => a.roleName === r).map((a) => h('option', { value: String(a.id), selected: state.defaultAssigneeId === String(a.id) }, a.fullName)))));
    assignee.addEventListener('change', () => { state.defaultAssigneeId = assignee.value; });

    const skip = h('input', { type: 'checkbox', id: 'bu-skip', checked: state.skipDuplicates });
    skip.addEventListener('change', () => { state.skipDuplicates = skip.checked; });

    const check = h('button', { class: 'btn btn-primary', type: 'button' }, 'Check file');
    check.addEventListener('click', async () => {
      if (!state.csv) return renderChoose('Choose a CSV file first.');
      if (!state.defaultSource) return renderChoose('Select a default lead source.');
      check.disabled = true;
      check.textContent = 'Checking…';
      try {
        state.preview = await http.post('/api/leads/import', body(true));
        renderPreview();
      } catch (err) {
        renderChoose(err.message);
      }
    });

    mount(host,
      error ? h('div', { class: 'alert alert-error bu-alert', role: 'alert' }, icon('alert'), h('div', error)) : null,
      h('div', { class: 'bu-steps' }, step(1, 'Choose file', true), step(2, 'Check', false), step(3, 'Import', false)),
      h('div', { class: 'bu-template' },
        h('div', null, h('strong', 'Columns'), h('p', { class: 'muted' }, 'Required: Full name, Mobile. Optional: Country code (default 91), Email, Source, Assign to (login email), Note.')),
        h('button', { class: 'btn btn-sm', type: 'button', onClick: downloadTemplate }, icon('download', 14), 'Download template'),
      ),
      fileInput, drop,
      h('div', { class: 'form-grid bu-options' },
        h('div', { class: 'field' }, h('label', { class: 'label', htmlFor: 'bu-source' }, 'Default lead source'), source,
          h('p', { class: 'hint' }, 'Used when a row has no Source. Sources cannot be changed after import.')),
        h('div', { class: 'field' }, h('label', { class: 'label', htmlFor: 'bu-assignee' }, 'Default assign to'), assignee,
          h('p', { class: 'hint' }, 'Used when a row has no "Assign to"')),
        h('label', { class: 'bu-check form-span', htmlFor: 'bu-skip' }, skip, ' Skip leads that already exist (same mobile or email)', h('span', { class: 'muted' }, ' — recommended')),
      ),
      footer(h('button', { class: 'btn', type: 'button', onClick: close }, 'Cancel'), check),
    );
  }

  // ---------------------------------------------------------------- step 2
  function renderPreview(error) {
    const { summary, rows } = state.preview;
    const order = { error: 0, duplicate: 1, ready: 2 };
    const sorted = [...rows].sort((a, b) => order[a.status] - order[b.status] || a.line - b.line);
    const shown = sorted.slice(0, PREVIEW_LIMIT);

    const importBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: summary.willCreate === 0 },
      summary.willCreate ? `Import ${summary.willCreate} lead${summary.willCreate === 1 ? '' : 's'}` : 'Nothing to import');
    importBtn.addEventListener('click', async () => {
      importBtn.disabled = true;
      importBtn.textContent = 'Importing…';
      try {
        const res = await http.post('/api/leads/import', body(false));
        renderDone(res.summary);
        onDone?.();
      } catch (err) {
        renderPreview(err.message);
      }
    });

    const statusCell = (r) => {
      if (r.status === 'error') return [h('span', { class: 'tag tag-danger' }, 'Error'), h('span', { class: 'bu-msg' }, r.errors.join('; '))];
      if (r.status === 'duplicate') {
        return [h('span', { class: 'tag tag-warning' }, state.skipDuplicates ? 'Skipped' : 'Duplicate'),
          h('span', { class: 'bu-msg' }, `Already exists: ${r.duplicateOf}`)];
      }
      return h('span', { class: 'tag tag-success' }, 'Ready');
    };

    mount(host,
      error ? h('div', { class: 'alert alert-error bu-alert', role: 'alert' }, icon('alert'), h('div', error)) : null,
      h('div', { class: 'bu-steps' }, step(1, 'Choose file', false, true), step(2, 'Check', true), step(3, 'Import', false)),
      h('div', { class: 'bu-summary' },
        tile('Rows in file', summary.total),
        tile('Ready to import', summary.ready, 'ok'),
        tile(state.skipDuplicates ? 'Duplicates (skipped)' : 'Duplicates (imported)', summary.duplicates, 'warn'),
        tile('Rows with errors', summary.errors, 'err'),
      ),
      summary.errors ? h('p', { class: 'hint bu-hint' }, 'Rows with errors are not imported. Fix them in your file and upload it again, or import the ready rows now.') : null,
      h('div', { class: 'table-wrap bu-table' },
        h('table', { class: 'data' },
          h('thead', h('tr', h('th', 'Row'), h('th', 'Name'), h('th', 'Mobile'), h('th', 'Source'), h('th', 'Assign to'), h('th', 'Result'))),
          h('tbody', shown.map((r) => h('tr', { class: `bu-row-${r.status}` },
            h('td', { class: 'num' }, String(r.line)),
            h('td', null, r.fullName || h('span', { class: 'muted' }, '—')),
            h('td', { class: 'nowrap' }, r.mobile || h('span', { class: 'muted' }, '—')),
            h('td', null, SOURCE_LABELS[r.source] || '—'),
            h('td', null, r.owner || h('span', { class: 'muted' }, 'Unassigned')),
            h('td', { class: 'bu-result' }, statusCell(r)),
          ))),
        ),
      ),
      rows.length > PREVIEW_LIMIT ? h('p', { class: 'hint' }, `Showing ${PREVIEW_LIMIT} of ${rows.length} rows (problems first).`) : null,
      footer(h('button', { class: 'btn', type: 'button', onClick: () => { state.preview = null; renderChoose(); } }, 'Back'), importBtn),
    );
  }

  // ---------------------------------------------------------------- step 3
  function renderDone(summary) {
    mount(host,
      h('div', { class: 'bu-steps' }, step(1, 'Choose file', false, true), step(2, 'Check', false, true), step(3, 'Import', true)),
      h('div', { class: 'bu-done' },
        h('div', { class: 'done-mark' }, icon('check', 26)),
        h('h3', `${summary.created} lead${summary.created === 1 ? '' : 's'} imported`),
        h('p', { class: 'muted' }, [
          summary.duplicates && state.skipDuplicates ? `${summary.duplicates} duplicate${summary.duplicates === 1 ? '' : 's'} skipped. ` : '',
          summary.errors ? `${summary.errors} row${summary.errors === 1 ? '' : 's'} with errors not imported. ` : '',
          'Assigned counselors have been notified.',
        ].join('')),
      ),
      footer(h('button', { class: 'btn', type: 'button', onClick: close }, 'Close'),
        h('button', { class: 'btn btn-primary', type: 'button', onClick: () => { close(); ctx.navigate('/app/leads'); } }, 'View leads')),
    );
    toast(`${summary.created} leads imported.`);
  }

  // ---------------------------------------------------------------- helpers
  function body(dryRun) {
    return {
      csv: state.csv,
      defaultSource: state.defaultSource,
      defaultAssigneeId: state.defaultAssigneeId ? Number(state.defaultAssigneeId) : null,
      skipDuplicates: state.skipDuplicates,
      dryRun,
    };
  }

  renderChoose();
}

function step(n, label, active, done) {
  return h('div', { class: ['bu-step', active && 'is-active', done && 'is-done'] },
    h('span', { class: 'bu-step-dot' }, done ? icon('check', 12) : String(n)), label);
}

function tile(label, value, tone) {
  return h('div', { class: ['bu-tile', tone && `is-${tone}`] }, h('strong', String(value)), h('span', label));
}

function footer(...buttons) {
  return h('div', { class: 'bu-foot' }, h('div', { class: 'spacer' }), buttons);
}

function downloadTemplate() {
  const url = URL.createObjectURL(new Blob(['﻿' + TEMPLATE], { type: 'text/csv;charset=utf-8' }));
  const a = h('a', { href: url, download: 'lead-upload-template.csv' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
