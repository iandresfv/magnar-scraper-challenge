/**
 * One-shot repair for `02-search-response-30-truncado.html`.
 *
 * The fixture was captured by a tool that decoded the server's UTF-8 bytes as latin1 and then
 * saved the result as UTF-8. That is a lossless but wrong round-trip: every original byte
 * survives, re-encoded one code point per byte. `serao` (with tilde) left the server as
 * `73 65 72 C3 A3 6F` and reached disk as `73 65 72 C3 83 C2 A3 6F` — the `C3 A3` pair read as
 * two latin1 characters and re-encoded as two UTF-8 sequences.
 *
 * The inverse is exact: decode the file as UTF-8, then re-encode each code point as one latin1
 * byte. `Buffer.from(text, 'latin1')` does precisely that and recovers the server's bytes.
 *
 * Idempotence matters more than it looks: this script is committed and someone will run it
 * twice. The repair is therefore gated on detecting the damage first — a clean file is left
 * untouched — and the recovered bytes are validated before anything is written.
 *
 * Usage: `npx tsx scripts/fix-fixture-encoding.ts [file...]`
 */
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * The signature of UTF-8 decoded as latin1: a lead byte (C2/C3, which render as the two
 * capital A variants) followed by what was a UTF-8 continuation byte (0x80-0xBF). Real
 * Portuguese text never produces this pair.
 */
const MOJIBAKE = /[ÂÃ][-¿]/;

export interface RepairOutcome {
  file: string;
  repaired: boolean;
  reason: string;
  bytesBefore: number;
  bytesAfter: number;
}

export function repairDoubleEncoding(original: Buffer): { buffer: Buffer; repaired: boolean } {
  const text = original.toString('utf8');
  if (!MOJIBAKE.test(text)) return { buffer: original, repaired: false };

  const recovered = Buffer.from(text, 'latin1');
  // Guard against making things worse: the recovered bytes must decode as valid UTF-8 and must
  // no longer show the signature. If they do not, the file is damaged some other way and this
  // script is the wrong tool for it.
  const check = new TextDecoder('utf-8', { fatal: false }).decode(recovered);
  if (MOJIBAKE.test(check) || check.includes('�')) {
    return { buffer: original, repaired: false };
  }
  return { buffer: recovered, repaired: true };
}

export function repairFile(file: string): RepairOutcome {
  const original = readFileSync(file);
  const { buffer, repaired } = repairDoubleEncoding(original);
  if (repaired) writeFileSync(file, buffer);
  return {
    file,
    repaired,
    reason: repaired ? 'double-encoded utf-8 recovered' : 'no mojibake signature; left untouched',
    bytesBefore: original.byteLength,
    bytesAfter: buffer.byteLength,
  };
}

const DEFAULT_TARGETS = ['src/sites/br-trf5/fixtures/02-search-response-30-truncado.html'];

function main(): void {
  const args = process.argv.slice(2);
  for (const file of args.length > 0 ? args : DEFAULT_TARGETS) {
    const out = repairFile(file);
    process.stdout.write(
      `${out.repaired ? 'repaired' : 'skipped '} ${out.file} ` +
        `(${out.bytesBefore} -> ${out.bytesAfter} bytes: ${out.reason})\n`,
    );
  }
}

if (process.argv[1]?.endsWith('fix-fixture-encoding.ts') === true) main();
