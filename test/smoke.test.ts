import { describe, expect, it } from 'vitest';
import { resolveVersion } from '../src/app/version.js';

describe('project skeleton', () => {
  it('resolves the package version from package.json', () => {
    expect(resolveVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('runs on a Node release that has fetch, parseArgs and --env-file', () => {
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    expect(major > 20 || (major === 20 && minor >= 6)).toBe(true);
  });
});
