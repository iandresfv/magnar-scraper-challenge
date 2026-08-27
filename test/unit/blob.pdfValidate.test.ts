import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validatePdf } from '../../src/infra/blob/pdfValidate.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'sites',
  'br-trf5',
  'fixtures',
);

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'));
const padTo = (size: number, head: string, tail: string): Uint8Array =>
  bytes(head + 'x'.repeat(Math.max(0, size - head.length - tail.length)) + tail);

describe('validatePdf', () => {
  it('accepts the two real PDFs the site actually served', () => {
    for (const name of ['04-reportPDF-16730.pdf', '05-reportReciboPDF-7222997.pdf']) {
      const data = new Uint8Array(readFileSync(join(FIXTURES, name)));
      const result = validatePdf({ bytes: data, declaredLength: data.byteLength });
      expect(result.ok, `${name}: ${JSON.stringify(result)}`).toBe(true);
      if (result.ok) expect(result.version).toBe('1.4');
    }
  });

  it('rejects HTML served where a PDF was expected, and says why', () => {
    // The measured failure: a dead session makes reportPDF.seam answer 200 with a login page.
    const html = bytes('<!DOCTYPE html><html><head><title>Consulta</title>'.padEnd(5_000, ' '));
    const result = validatePdf({ bytes: html, contentType: 'text/html' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('NOT_PDF');
      expect(result.detail).toContain('HTML');
      expect(result.detail).toContain('session');
    }
  });

  it('rejects arbitrary binary that is not a PDF', () => {
    const result = validatePdf({ bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_PDF');
  });

  it('rejects a body whose length contradicts the declared Content-Length', () => {
    const data = padTo(4_000, '%PDF-1.4\n', '\n%%EOF\n');
    const result = validatePdf({ bytes: data, declaredLength: 9_999 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('PDF_LENGTH_MISMATCH');
      expect(result.detail).toContain('9999');
    }
  });

  it('rejects a PDF truncated before its EOF marker', () => {
    const full = padTo(4_000, '%PDF-1.4\n', '\n%%EOF\n');
    const cut = full.subarray(0, full.byteLength - 100);
    const result = validatePdf({ bytes: cut });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('PDF_TRUNCATED');
  });

  it('rejects a tiny body that merely starts like a PDF', () => {
    const result = validatePdf({ bytes: bytes('%PDF-1.4\nerror\n%%EOF\n') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('PDF_TOO_SMALL');
  });

  it('accepts trailing whitespace after the EOF marker', () => {
    const data = bytes(`%PDF-1.4\n${'x'.repeat(3_000)}\n%%EOF\n\n\n   \n`);
    expect(validatePdf({ bytes: data }).ok).toBe(true);
  });

  it('accepts an incremental update, where %%EOF appears more than once', () => {
    const data = bytes(`%PDF-1.7\n${'x'.repeat(3_000)}\n%%EOF\n${'y'.repeat(200)}\n%%EOF\n`);
    const result = validatePdf({ bytes: data });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.version).toBe('1.7');
  });

  it('rejects an EOF that sits too far from the end to be the real trailer', () => {
    const data = bytes(`%PDF-1.4\n%%EOF\n${'x'.repeat(5_000)}`);
    const result = validatePdf({ bytes: data });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('PDF_TRUNCATED');
  });

  it('rejects an empty body', () => {
    const result = validatePdf({ bytes: new Uint8Array() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_PDF');
  });

  it('checks the magic number before anything else, so the message names the real problem', () => {
    // An HTML page that is also the wrong length should be reported as HTML, not as a mismatch.
    const html = bytes('<html>'.padEnd(3_000, ' '));
    const result = validatePdf({ bytes: html, declaredLength: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_PDF');
  });
});
