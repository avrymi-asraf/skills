import { describe, it, expect } from 'vitest';
import { detectForge, generateTitle, parseMrOptions, slugify } from './mr.ts';

describe('mr', () => {
  it('parses options', () => {
    expect(parseMrOptions(['-m', 'Fix bug', '-b', 'dev', '--draft'])).toEqual({
      options: { message: 'Fix bug', base: 'dev', draft: true },
      errors: [],
    });
    expect(parseMrOptions(['-m']).errors).toHaveLength(1);
    expect(parseMrOptions(['--nope']).errors).toHaveLength(1);
  });

  it('generates titles from changed files', () => {
    expect(generateTitle(['src/a.ts'])).toBe('Update src/a.ts');
    expect(generateTitle(['src/a.ts', 'src/b.ts'])).toBe('Update 2 files in src');
    expect(generateTitle(['src/a.ts', 'README.md'])).toBe('Update 2 files');
  });

  it('slugifies and detects forge', () => {
    expect(slugify('Fix: the Bug!')).toBe('fix-the-bug');
    expect(slugify('!!!')).toBe('changes');
    expect(detectForge('git@gitlab.com:a/b.git')).toBe('gitlab');
    expect(detectForge('https://github.com/a/b')).toBe('github');
  });
});
