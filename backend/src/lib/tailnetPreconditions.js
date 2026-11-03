// Supervisor contract: check this before starting the tunnel daemon on every start AND restart,
// not only when someone clicks enable. A restored database can have no admin even if it once did.
export function firstAdminExists(db) {
  return Boolean(db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get());
}

export function tailnetEnableBlocker(db) {
  if (firstAdminExists(db)) return null;
  return {
    code: 'no_admin',
    message: 'Create the first admin account on your home network before turning on Tailscale.',
  };
}
