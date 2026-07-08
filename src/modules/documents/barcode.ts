// Barcode generation for the tracking code, as a data URI to embed in the
// AWB / receipt HTML. Uses Code 128 (the standard for alphanumeric shipping
// tracking numbers). Rendered to PNG so it embeds cleanly in HTML->PDF.

import bwipjs from "bwip-js";

/** Returns a `data:image/png;base64,...` URI for a Code 128 barcode of `text`. */
export async function barcodeDataUri(text: string): Promise<string> {
  const png = await bwipjs.toBuffer({
    bcid: "code128",
    text,
    scale: 3,
    height: 12,        // bar height in mm-ish units
    includetext: true, // print the human-readable text under the bars
    textxalign: "center",
    textsize: 9,
  });
  return `data:image/png;base64,${png.toString("base64")}`;
}
