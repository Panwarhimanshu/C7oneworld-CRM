'use strict';

// Minimal RFC 4180 CSV parser: quoted fields, escaped quotes (""), commas and line
// breaks inside quotes, CRLF/LF line endings and a leading UTF-8 BOM (Excel).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const s = String(text).replace(/^﻿/, '');

  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"' && field === '') { quoted = true; i += 1; continue; }
    if (c === ',') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
      i += c === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; i += 1;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // Drop fully blank lines.
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

module.exports = { parseCsv };
