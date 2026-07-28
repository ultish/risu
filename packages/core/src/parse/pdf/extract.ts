import pdfParse from "pdf-parse";

export type ExtractedPdf = {
  text: string;
  numpages: number;
};

/**
 * Extract raw text from a born-digital PDF (operator annual statements).
 * No OCR — Betashares/Computershare/Link statements are born-digital (see
 * docs/import-layouts-plan.md §1 non-goals). Some fonts drop a stray "r" or
 * "ff" ligature on extract (e.g. "charged" → "cha ged") — layout regexes
 * must tolerate this, not extractPdf.
 */
export async function extractPdf(buf: Buffer): Promise<ExtractedPdf> {
  const data = await pdfParse(buf);
  return { text: data.text ?? "", numpages: data.numpages ?? 0 };
}
