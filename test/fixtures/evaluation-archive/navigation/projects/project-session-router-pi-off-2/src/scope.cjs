// A scope identity is the exact tuple (server, directory, engine, session).
// Events are applicable only when ALL four fields match exactly.
exports.matches=(a,b)=>Boolean(
  a&&b&&
  a.server===b.server&&
  a.directory===b.directory&&
  a.engine===b.engine&&
  a.session===b.session
);
