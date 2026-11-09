import { Lock, LockOpen } from 'lucide-react';

export const PROTECTED_NOTE = 'Protected: kept until you unprotect it. Unprotecting a clip older than your Keep clips for setting lets the next cleanup remove it.';

export function ProtectedBadge() {
  return <span className="clip-protected-badge" aria-label="Protected" title="Protected"><Lock size={12} aria-hidden="true" />Protected</span>;
}

export function ProtectionNote({ protected: isProtected, error }) {
  return <>
    {isProtected && <div className="clip-protection-note">{PROTECTED_NOTE}</div>}
    {error && <div className="error-banner" role="alert">{error}</div>}
  </>;
}

export function ProtectButton({ protected: isProtected, busy, onClick }) {
  const label = isProtected ? 'Unprotect this clip' : 'Protect this clip';
  const Icon = isProtected ? LockOpen : Lock;
  return <button type="button" className="icon-btn" aria-label={label} title={label}
    aria-pressed={!!isProtected} disabled={busy} onClick={onClick}><Icon size={17} aria-hidden="true" /></button>;
}
