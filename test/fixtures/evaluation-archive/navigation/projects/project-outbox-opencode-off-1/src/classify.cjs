const statusOf = err => {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) return undefined;
  if (typeof err.status === 'number') return err.status;
  if (typeof err.statusCode === 'number') return err.statusCode;
  if (err.response && typeof err.response.status === 'number') return err.response.status;
  if (typeof err.status === 'string' && /^\d+$/.test(err.status)) return Number(err.status);
  if (typeof err.statusCode === 'string' && /^\d+$/.test(err.statusCode)) return Number(err.statusCode);
  return undefined;
};

exports.classify = err => {
  const status = statusOf(err);
  if (typeof status !== 'number') return 'uncertain';
  if (status === 408) return 'uncertain';
  if (status >= 500) return 'uncertain';
  if (status >= 400) return 'rejected';
  return 'uncertain';
};
