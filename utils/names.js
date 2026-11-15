'use strict';

function splitFullName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return {
    last_name: parts[0] || '',
    first_name: parts[1] || '',
    middle_name: parts[2] || '',
  };
}

function composeName(last, first, middle) {
  return [last, first, middle]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' ');
}

module.exports = { splitFullName, composeName };