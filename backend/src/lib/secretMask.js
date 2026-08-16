// Show just enough of a saved secret (API token, key) for an admin to recognise WHICH one it is,
// without ever sending the whole thing back to the client. Azure-style: a short leading prefix then
// dots. Config GET endpoints return this instead of the raw value; the real secret stays server-side.
export function maskSecret(s) {
  const str = (s || '').trim();
  if (!str) return '';
  // Too short to reveal any prefix safely — mask the whole thing (length preserved as a hint).
  if (str.length <= 8) return '•'.repeat(str.length);
  return `${str.slice(0, 4)}${'•'.repeat(6)}`;
}
