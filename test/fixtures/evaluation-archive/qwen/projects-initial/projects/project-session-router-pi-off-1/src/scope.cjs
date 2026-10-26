// Routing predicate: an event is applicable only when server, directory,
// engine AND session all match exactly. Missing scopes never match.
const FIELDS = ['server', 'directory', 'engine', 'session'];

exports.matches = (a, b) => {
  if (!a || typeof a !== 'object' || !b || typeof b !== 'object') return false;
  return FIELDS.every((f) => a[f] === b[f]);
};

exports.FIELDS = FIELDS;
