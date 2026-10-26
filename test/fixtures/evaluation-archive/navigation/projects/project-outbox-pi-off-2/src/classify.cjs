// Domain classification of a delivery failure.
// Returns the *state* a queue entry should move to after a failed POST:
//  - 'rejected'  : permanent failure, never retried automatically (HTTP 4xx, except 408)
//  - 'uncertain' : delivery could not be confirmed (transport error, 408, 5xx/other)
// A transport error carries no HTTP response at all and is therefore uncertain.
const statusOf = err => {
  if (!err || typeof err !== 'object') return undefined;
  if (typeof err.status === 'number') return err.status;
  if (typeof err.statusCode === 'number') return err.statusCode;
  if (err.response && typeof err.response.status === 'number') return err.response.status;
  return undefined;
};

exports.statusOf = statusOf;

exports.classify = err => {
  const status = statusOf(err);
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) {
    return 'rejected';
  }
  // Transport error, 408, 5xx, or anything else we cannot confirm.
  return 'uncertain';
};
