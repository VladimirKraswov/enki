// A routing event is applicable only when server, directory, engine and
// session ALL match exactly between state scope and event scope.
exports.matches = (a, b) =>
  !!a &&
  !!b &&
  a.server === b.server &&
  a.directory === b.directory &&
  a.engine === b.engine &&
  a.session === b.session;
