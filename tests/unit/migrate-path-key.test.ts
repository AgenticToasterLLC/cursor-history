import { afterEach, describe, expect, it } from 'vitest';
import { normalizedPathKey } from '../../src/core/migrate.js';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...realPlatform, value });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
});

describe('normalizedPathKey', () => {
  it('unifies every Windows spelling of one path, case-insensitively', () => {
    setPlatform('win32');
    const spellings = [
      '/C:/Users/Me/Project',
      'C:/Users/Me/Project',
      'c:\\users\\me\\project',
      'C:\\Users\\Me\\Project\\',
      'file:///C:/Users/Me/Project',
      'file:///c%3A/Users/Me/Project',
    ];
    const keys = new Set(spellings.map(normalizedPathKey));
    expect([...keys]).toEqual(['c:/users/me/project']);
  });

  it('keeps different Windows paths distinct', () => {
    setPlatform('win32');
    expect(normalizedPathKey('C:/a/b')).not.toBe(normalizedPathKey('/C:/a/c'));
    expect(normalizedPathKey('C:/a/b')).not.toBe(normalizedPathKey('D:/a/b'));
  });

  it('stays case-sensitive and lexical on POSIX', () => {
    setPlatform('linux');
    expect(normalizedPathKey('/home/me/Project/')).toBe('/home/me/Project');
    expect(normalizedPathKey('/home/me/Project')).not.toBe(normalizedPathKey('/home/me/project'));
    expect(normalizedPathKey('/C:/x')).toBe('/C:/x');
  });
});
