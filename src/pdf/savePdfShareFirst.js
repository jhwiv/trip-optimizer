// Share-first PDF save. Tries the Web Share API before falling back to
// jsPDF's anchor download.
//
// Why this exists: on iOS 13+ Safari, `pdf.save()` writes straight to the
// Files app's Downloads folder with no chooser. It did not always behave that
// way. jsPDF's bundled FileSaver branches on `"download" in
// HTMLAnchorElement.prototype`; pre-iOS-13 Safari failed that check, so the
// PDF was handed to `window.open` and rendered inline, where Safari's own
// Share button offered "Save to Files" with a folder picker. iOS 13 added
// `download` attribute support, the anchor branch started winning, and the
// picker disappeared. Nothing in this repo changed — the platform did.
//
// `navigator.share({ files })` gets that chooser back deliberately rather than
// by accident: the iOS Share Sheet lists "Save to Files" (with folder picker)
// alongside AirDrop, Mail, and Books.
//
// Feature-detected via `canShare({ files })`, never by user agent — some
// browsers expose `navigator.share` but reject file payloads, and a UA sniff
// would go stale the next time Safari changes its mind.

/**
 * @param {{ output: (type: string) => Blob, save: (filename: string) => void }} pdfDoc
 * @param {string} filename
 */
export async function savePdfShareFirst(pdfDoc, filename) {
  const file = new File([pdfDoc.output("blob")], filename, { type: "application/pdf" });

  if (typeof navigator !== "undefined" &&
      typeof navigator.canShare === "function" &&
      navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (err) {
      // The user dismissed the sheet. Downloading anyway would drop the file
      // somewhere they never asked for — the exact behavior this replaces.
      if (err?.name === "AbortError") return;
      // Anything else (expired user activation, payload rejected, sheet
      // unavailable) is a failure of the nicer path, not of the user's intent.
    }
  }

  pdfDoc.save(filename);
}
