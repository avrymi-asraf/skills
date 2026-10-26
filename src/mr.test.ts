import { describe, it, expect } from 'vitest';
import { generateTitle, isGitLab, parseMrOptions, skillFolder, slugify } from './mr.ts';

describe('mr', () => {
  it('parses options and skill names', () => {
    expect(parseMrOptions(['pdf', '-m', 'Fix', '-b', 'dev', '-d', '-g', '-y'])).toEqual({
      options: {
        skills: ['pdf'],
        message: 'Fix',
        base: 'dev',
        draft: true,
        global: true,
        yes: true,
      },
      errors: [],
    });
    expect(parseMrOptions(['-m']).errors).toHaveLength(1);
    expect(parseMrOptions(['--nope']).errors).toHaveLength(1);
  });

  it('derives the skill folder from the locked SKILL.md path', () => {
    expect(skillFolder('skills/pdf/SKILL.md')).toBe('skills/pdf');
    expect(skillFolder('SKILL.md')).toBe('');
    expect(skillFolder('skills/pdf')).toBe('skills/pdf');
  });

  it('generates titles, slugs and detects gitlab', () => {
    expect(generateTitle(['a', 'b'])).toBe('Update a, b');
    expect(generateTitle(['a', 'b', 'c', 'd'])).toBe('Update 4 skills');
    expect(slugify('Update: PDF!')).toBe('update-pdf');
    expect(isGitLab('https://gitlab.com/a/b.git')).toBe(true);
  });
});
