exports.classify = err => {
  const status = err && (
    (typeof err.status === 'number' && err.status) ||
    (typeof err.statusCode === 'number' && err.statusCode) ||
    (err.response && typeof err.response.status === 'number' && err.response.status)
  );
  if (typeof status === 'number') {
    if (status === 408) return 'uncertain';
    if (status >= 400 && status < 500) return 'rejected';
    if (status >= 500) return 'uncertain';
  }
  return 'uncertain';
};
