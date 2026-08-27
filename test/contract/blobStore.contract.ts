/**
 * The `BlobStore` contract, satisfied by both the filesystem and any S3-compatible backend.
 *
 * One suite, two very different implementations — which is the only way to know the interface
 * is an abstraction rather than a description of whichever one was written first.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BlobStore } from '../../src/core/ports/blobStore.js';
import { sha256Hex } from '../../src/core/domain/hash.js';

export interface BlobStoreSubject {
  name: string;
  create: () => Promise<BlobStore>;
  cleanup?: () => Promise<void>;
}

const PDF = new Uint8Array(
  Buffer.from(`%PDF-1.4\n${'x'.repeat(2_000)}\ntrailer\n%%EOF\n`, 'latin1'),
);

export function runBlobStoreContract(subject: BlobStoreSubject): void {
  describe(`BlobStore contract: ${subject.name}`, () => {
    let store: BlobStore;
    const key = `br-trf5/2024/0000007-07.1985.8.20.0124/0000007-07.1985.8.20.0124__relatorio.pdf`;

    beforeAll(async () => {
      store = await subject.create();
      await store.init();
    });

    afterAll(async () => {
      await subject.cleanup?.();
    });

    it('init is idempotent', async () => {
      await expect(store.init()).resolves.toBeUndefined();
    });

    it('returns null for a key that was never stored', async () => {
      expect(await store.head('br-trf5/2024/nothing/nothing__relatorio.pdf')).toBeNull();
    });

    it('stores and reads back the exact bytes', async () => {
      const result = await store.put(key, PDF, {
        contentType: 'application/pdf',
        sha256: sha256Hex(PDF),
      });
      expect(result.bytes).toBe(PDF.byteLength);
      expect(result.uri).toContain('0000007-07.1985.8.20.0124__relatorio.pdf');

      const read = await store.get(key);
      expect(Buffer.from(read).equals(Buffer.from(PDF))).toBe(true);
    });

    it('reports size and hash from head, so a re-run can skip the download', async () => {
      const head = await store.head(key);
      expect(head?.bytes).toBe(PDF.byteLength);
      expect(head?.sha256).toBe(sha256Hex(PDF));
    });

    it('is idempotent: storing the same key twice leaves one object with the same content', async () => {
      await store.put(key, PDF, { contentType: 'application/pdf', sha256: sha256Hex(PDF) });
      const head = await store.head(key);
      expect(head?.bytes).toBe(PDF.byteLength);
      expect(Buffer.from(await store.get(key)).equals(Buffer.from(PDF))).toBe(true);
    });

    it('overwrites deliberately when the content changed', async () => {
      const longer = new Uint8Array(
        Buffer.from(`%PDF-1.4\n${'y'.repeat(3_000)}\n%%EOF\n`, 'latin1'),
      );
      await store.put(key, longer, { contentType: 'application/pdf', sha256: sha256Hex(longer) });
      expect((await store.head(key))?.bytes).toBe(longer.byteLength);
      // Put the original back so later assertions see a stable state.
      await store.put(key, PDF, { contentType: 'application/pdf', sha256: sha256Hex(PDF) });
    });

    it('builds a uri without touching the network, for a key that does not exist yet', () => {
      expect(store.uri('br-trf5/2024/x/x__relatorio.pdf')).toContain('x__relatorio.pdf');
    });

    it('keeps keys with several path segments apart', async () => {
      const a = 'br-trf5/2024/case-a/case-a__relatorio.pdf';
      const b = 'br-trf5/2025/case-b/case-b__relatorio.pdf';
      await store.put(a, PDF, { contentType: 'application/pdf', sha256: sha256Hex(PDF) });
      await store.put(b, PDF, { contentType: 'application/pdf', sha256: sha256Hex(PDF) });
      expect(await store.head(a)).not.toBeNull();
      expect(await store.head(b)).not.toBeNull();
      expect(store.uri(a)).not.toBe(store.uri(b));
    });

    it('stores a receipt alongside the cover for the same case', async () => {
      const receipt =
        'br-trf5/2024/0000007-07.1985.8.20.0124/0000007-07.1985.8.20.0124__recibo__7222997.pdf';
      await store.put(receipt, PDF, { contentType: 'application/pdf', sha256: sha256Hex(PDF) });
      expect(await store.head(receipt)).not.toBeNull();
      expect(await store.head(key)).not.toBeNull();
    });

    it('reports its driver and a target that is safe to print', () => {
      expect(['fs', 's3']).toContain(store.driver);
      expect(store.target).not.toBe('');
    });
  });
}
