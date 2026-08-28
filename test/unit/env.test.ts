/**
 * `.env`, and the three ways it used to be wrong.
 *
 * These tests exist because copying `.env.example` to `.env` and running the first command in the
 * README did not work: nobody read the file. The blank values it ships on purpose are the other
 * half of that story, in `config.test.ts`.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadEnvFile } from '../../src/app/env.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'juris-env-'));
});

const write = async (body: string): Promise<string> => {
  const path = join(dir, '.env');
  await writeFile(path, body);
  return path;
};

describe('loading a .env file', () => {
  it('sets what it finds', async () => {
    const env: NodeJS.ProcessEnv = {};
    const path = await write(
      'DATABASE_URL=postgres://juris:juris@localhost:55432/juris\nSITE=br-trf5\n',
    );

    expect(loadEnvFile({ path, env })).toEqual(['DATABASE_URL', 'SITE']);
    expect(env['DATABASE_URL']).toBe('postgres://juris:juris@localhost:55432/juris');
  });

  it('never overrides the real environment', async () => {
    // A value exported in a shell, or injected by compose, is more specific than a file.
    const env: NodeJS.ProcessEnv = { SITE: 'fake-pje' };
    const path = await write('SITE=br-trf5\n');

    expect(loadEnvFile({ path, env })).toEqual([]);
    expect(env['SITE']).toBe('fake-pje');
  });

  it('ignores comments, blank lines and malformed ones', async () => {
    const env: NodeJS.ProcessEnv = {};
    const path = await write('# a comment\n\n  \nNOT_A_PAIR\n=novalue\nSITE=br-trf5\n');

    expect(loadEnvFile({ path, env })).toEqual(['SITE']);
  });

  it('keeps a value that contains its own separators', async () => {
    const env: NodeJS.ProcessEnv = {};
    const path = await write('DATABASE_URL=postgres://u:p@h:5432/db?a=b\n');

    expect(loadEnvFile({ path, env })).toEqual(['DATABASE_URL']);
    expect(env['DATABASE_URL']).toBe('postgres://u:p@h:5432/db?a=b');
  });

  it('strips one layer of matching quotes', async () => {
    const env: NodeJS.ProcessEnv = {};
    const path = await write('A="quoted"\nB=\'single\'\nC="mismatched\n');

    loadEnvFile({ path, env });
    expect([env['A'], env['B'], env['C']]).toEqual(['quoted', 'single', '"mismatched']);
  });

  it('says nothing and does nothing when there is no file', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadEnvFile({ path: join(dir, 'absent'), env })).toEqual([]);
    expect(Object.keys(env)).toEqual([]);
  });
});
