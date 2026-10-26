'use strict';

// A scope is only comparable on the four routing coordinates.
// All of them must be present on both sides and equal exactly.
const FIELDS = ['server', 'directory', 'engine', 'session'];

exports.FIELDS = FIELDS;

exports.matches = (a, b) => {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  return FIELDS.every((field) => a[field] === b[field]);
};
