'use strict';

function parseLine(line, delimiter) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === delimiter) { result.push(current); current = ''; }
      else current += ch;
    }
  }
  result.push(current);
  return result;
}

function detectDelimiter(line) {
  const semi = (line.match(/;/g) || []).length;
  const comma = (line.match(/,/g) || []).length;
  return semi >= comma ? ';' : ',';
}

function splitCsvRecords(text) {
  const records = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      current += ch;
      if (ch === '"') {
        if (text[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      }
    } else if (ch === '"') {
      inQuotes = true;
      current += ch;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (current.trim().length > 0) records.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) records.push(current);
  return records;
}

function parseCsv(text) {
  if (typeof text !== 'string' || text.length === 0) return { headers: [], rows: [] };
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const records = splitCsvRecords(text);
  if (records.length === 0) return { headers: [], rows: [] };
  const delimiter = detectDelimiter(records[0]);
  const headers = parseLine(records[0], delimiter).map((h) => h.trim().toLowerCase());
  const rows = [];
  for (let i = 1; i < records.length; i++) {
    const cells = parseLine(records[i], delimiter);
    const row = {};
    headers.forEach((h, idx) => { row[h] = (cells[idx] || '').trim(); });
    rows.push(row);
  }
  return { headers, rows };
}

function escapeCell(value) {
  let s = String(value == null ? '' : value);
  // Защита от CSV/Excel formula injection (OWASP).
  // Префикс '  — если ячейка начинается с = + - @ TAB CR.
  // Но чистые числа (-5) не трогаем — это не формула.
  if (s.length > 0 && /^[=+\-@\t\r]/.test(s)) {
    if (!/^-?\d+(?:\.\d+)?$/.test(s)) {
      s = "'" + s;
    }
  }
  if (/[;"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, headers, delimiter = ';') {
  const head = headers.map(escapeCell).join(delimiter);
  const body = rows.map((r) => headers.map((h) => escapeCell(r[h])).join(delimiter)).join('\r\n');
  return '\uFEFF' + head + '\r\n' + body + '\r\n';
}

function pick(row, aliases) {
  for (const key of aliases) {
    const v = row[key];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

module.exports = { parseCsv, toCsv, pick };