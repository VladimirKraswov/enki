const statusOf = err => {
  if (err == null) return undefined;
  if (typeof err === 'number') return err;
  if (typeof err.status === 'number') return err.status;
  if (typeof err.statusCode === 'number') return err.statusCode;
  if (err.response) {
    if (typeof err.response.status === 'number') return err.response.status;
    if (typeof err.response.statusCode === 'number') return err.response.statusCode;
  }
  return undefined;
};

exports.classify = err => {
  const status = statusOf(err);
  if (status === undefined) return 'uncertain';
  if (status === 408) return 'uncertain';
  if (status >= 400 && status < 500) return 'rejected';
  return 'uncertain';
};
