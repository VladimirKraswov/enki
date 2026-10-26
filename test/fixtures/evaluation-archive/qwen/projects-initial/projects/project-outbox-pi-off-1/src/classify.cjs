'use strict';

// Extract an HTTP status code from common error shapes.
function statusOf(err) {
  if (!err || typeof err !== 'object') return undefined;
  if (typeof err.status === 'number') return err.status;
  if (typeof err.statusCode === 'number') return err.statusCode;
  if (err.response && typeof err.response.status === 'number') {
    return err.response.status;
  }
  return undefined;
}

// Classify a post() failure.
// - HTTP 4xx (except 408): permanent rejection, never auto-retry -> 'rejected'
// - HTTP 408 or 5xx: delivery outcome is unknown -> 'uncertain'
// - Transport/other errors (no HTTP status): delivery outcome unknown -> 'uncertain'
function classify(err) {
  const status = statusOf(err);
  if (typeof status === 'number' && Number.isFinite(status)) {
    if (status >= 400 && status < 500 && status !== 408) return 'rejected';
    return 'uncertain';
  }
  return 'uncertain';
}

exports.classify = classify;
exports.statusOf = statusOf;
