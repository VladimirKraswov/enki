exports.classify = err => {
  const src = err || {};
  const raw =
    src.status !== undefined ? src.status
    : src.statusCode !== undefined ? src.statusCode
    : src.response && src.response.status;
  const status = Number(raw);
  if (raw !== undefined && raw !== null && Number.isFinite(status)) {
    if (status !== 408 && status >= 400 && status <= 499) return 'rejected';
  }
  return 'uncertain';
};
