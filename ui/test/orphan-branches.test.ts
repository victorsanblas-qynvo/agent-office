import { describe, expect, test } from 'bun:test';
import { aheadBehindText, orphanCommands } from '../src/settings/orphan-branches-model';

describe('orphan branches', () => {
  test('the commands to copy name the branch and the base', () => {
    expect(orphanCommands('encargo/login-a1b2', 'develop')).toEqual({
      delete: 'git branch -D encargo/login-a1b2',
      log: 'git log --oneline develop..encargo/login-a1b2',
    });
  });

  test('ahead and behind read as +N −M, with ? where git could not count', () => {
    expect(aheadBehindText({ ahead: 3, behind: 0 })).toBe('+3 −0');
    expect(aheadBehindText({ ahead: null, behind: null })).toBe('+? −?');
  });
});
