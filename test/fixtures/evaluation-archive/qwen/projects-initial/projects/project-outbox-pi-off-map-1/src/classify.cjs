exports.classify = err => {
  const status = err && err.status;
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) {
    return 'rejected';
  }
  // Transport error (no status), 408, or 5xx: delivery is uncertain.
  return 'uncertain';
};
