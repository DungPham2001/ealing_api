/**
 * GET /v1/reports/export?type=<report>&format=csv|pdf — indicators, ratios and counts only (never amounts).
 * The PDF is a minimal text document in the standard Helvetica font, so Vietnamese diacritics are folded to ASCII there.
 */
const { REPORTS } = require('./reports');
const { invalid } = require('../utils/AppError');

const DISCLAIMER = 'Không phải báo cáo tài chính chính thức, không phải chào mời đầu tư và không bảo đảm kết quả tương lai.';
const ascii = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^\x20-\x7e]/g, '?');

/** { a: { b: [1, 2] } } -> [['a.b[0]', 1], ['a.b[1]', 2]] */
function flatten(value, path = '', out = []) {
  if (value === null || value === undefined || typeof value !== 'object') out.push([path || 'value', value ?? '']);
  else if (Array.isArray(value)) {
    if (!value.length) out.push([path, '']);
    value.forEach((v, i) => flatten(v, `${path}[${i}]`, out));
  } else {
    const keys = Object.keys(value);
    if (!keys.length) out.push([path, '']);
    keys.forEach((k) => flatten(value[k], path ? `${path}.${k}` : k, out));
  }
  return out;
}

const csvCell = (v) => {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`; // spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => `﻿${['metric,value', ...rows.map(([k, v]) => `${csvCell(k)},${csvCell(v)}`), '', csvCell(DISCLAIMER)].join('\r\n')}\r\n`;

function toPdf(title, rows) {
  const esc = (s) => ascii(s).replace(/([\\()])/g, '\\$1');
  const wrap = (s, n = 95) => { const out = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out.length ? out : ['']; };
  const lines = [title, '', ...rows.flatMap(([k, v]) => wrap(`${k}: ${v}`)), '', ...wrap(DISCLAIMER)];
  const perPage = 60;
  const pages = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  const objs = [];
  const add = (body) => objs.push(body) && objs.length;
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids = pages.map((pg) => {
    const stream = `BT /F1 10 Tf 14 TL 40 800 Td ${pg.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = objs.map((body, i) => {
    const at = Buffer.byteLength(pdf);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

async function exportReport(q) {
  const { type, format } = q;
  if (!REPORTS[type]) throw invalid([{ field: 'type', code: 'invalid_enum', allowed: Object.keys(REPORTS) }]);
  if (!['csv', 'pdf'].includes(format)) throw invalid([{ field: 'format', code: 'invalid_enum', allowed: ['csv', 'pdf'] }]);
  const { type: _t, format: _f, ...rest } = q;
  const { data } = await REPORTS[type](rest);
  const rows = flatten(data);
  const name = `${type}-${new Date().toISOString().slice(0, 10)}.${format}`;
  return format === 'csv'
    ? { name, contentType: 'text/csv; charset=utf-8', body: toCsv(rows) }
    : { name, contentType: 'application/pdf', body: toPdf(`Ealing Holdings - ${type}`, rows) };
}

module.exports = { exportReport, flatten, DISCLAIMER };
