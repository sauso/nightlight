// Copy text to the clipboard and say whether it worked: 'copied' or 'manual' (the person has to copy it by hand).
//
// Owner testing 2026-11-05: the Tailscale card's Copy did nothing when Nightlight was opened over plain http on the home
// network, yet worked at the https `.ts.net` address. `navigator.clipboard` exists only in a secure context (https or
// localhost), and Nightlight is often run over http on a home network, so it cannot be the only way. The fallback is a
// temporary off-screen textarea and `document.execCommand('copy')`, which browsers still allow from a tap on an http page.
// The same three steps as CribZonePicker.copyZone (try the API, then the older way, then tell the person), kept separate
// because that one copies from a box that is already on screen.
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return 'copied';
    }
  } catch { /* denied or unavailable: fall through to the older way */ }
  let box = null;
  try {
    box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    // Off-screen but still selectable; display:none would make the browser refuse to select it.
    box.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(box);
    box.select();
    box.setSelectionRange(0, text.length);
    if (document.execCommand('copy')) return 'copied';
  } catch { /* no execCommand either */ } finally {
    box?.remove();
  }
  return 'manual';
}
