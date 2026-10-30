import { isNativeApp, hasFileExport, saveToDownloads, saveTextFile } from './nativeBridge.js';

// Save text as a file the person can keep: a normal download in a browser, the phone's Downloads folder (or the
// share sheet) in the native app. Returns a short message to show ('' for a browser download) and throws an Error
// whose message is fit to show when it cannot.
//
// The same behaviour as DiagnosticsCard.download, which has its own copy: kept separate so that card's tests and
// review stay out of this change. A follow-up can make that card call this.
export async function saveTextDownload(filename, text, mimeType) {
  if (isNativeApp()) {
    // An old installed app (running this newer web UI) may predate the file-export plugins: say so plainly instead
    // of a mystery "couldn't save".
    if (!hasFileExport()) {
      throw new Error('This version of the app can’t export files. Update to the latest app version and try again.');
    }
    if (await saveToDownloads(filename, text, mimeType)) return 'Saved to your Downloads folder.';
    if (await saveTextFile(filename, text)) return 'Shared — pick "Save to Files" to keep a copy.';
    throw new Error("Couldn't save the file on this device.");
  }
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return '';
}
