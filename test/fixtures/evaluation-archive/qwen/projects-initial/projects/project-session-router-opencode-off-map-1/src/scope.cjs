exports.matches=(a,b)=>!!a&&!!b&&a.server===b.server&&a.directory===b.directory&&a.engine===b.engine&&a.session===b.session;
