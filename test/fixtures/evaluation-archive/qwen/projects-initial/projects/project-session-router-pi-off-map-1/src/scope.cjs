// Routing keys: an event is applicable only when EVERY field matches exactly.
const ROUTING_FIELDS = ['server', 'directory', 'engine', 'session'];

exports.ROUTING_FIELDS = ROUTING_FIELDS;

exports.matches = (a, b) => {
  if (!a || typeof a !== 'object' || !b || typeof b !== 'object') return false;
  for (const field of ROUTING_FIELDS) {
    if (a[field] !== b[field]) return false;
  }
  return true;
};
