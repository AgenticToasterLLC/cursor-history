import { afterEach, describe, expect, it } from 'vitest';
import {
  createSessionIntegrityFixtureRoot,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';
import { runBuiltCli } from '../helpers/run-cli.js';

const fixtures: SessionIntegrityFixtureRoot[] = [];
afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.cleanup();
});

describe('cli --profile', () => {
  it('writes JSON to stderr and leaves stdout identical', async () => {
    const fx = createSessionIntegrityFixtureRoot('cursor-history-profile-');
    fixtures.push(fx);
    const session = {
      id: 'aaaaaaaa-0000-0000-0000-000000000042',
      title: 'Profile fixture',
      workspacePath: fx.projectA,
      createdAt: 1_700_000_000_000,
      messages: [{ role: 'user' as const, content: 'hello profile' }],
    };
    writeComposerWorkspaceSummary(fx, 'ws-a', fx.projectA, [session]);
    writeComposerGlobalSessions(fx, [session]);
    const env = { CURSOR_STORE_ROOT: fx.storeRoot };
    const base = ['--json', '--data-path', fx.workspaceStorage];

    const plain = await runBuiltCli([...base, 'list', '--all'], { env, timeoutMs: 30_000 });
    const profiled = await runBuiltCli(['--profile', ...base, 'list', '--all'], {
      env,
      timeoutMs: 30_000,
    });
    expect(plain.status).toBe(0);
    expect(plain.stderr).toBe('');
    expect(profiled.status).toBe(0);
    expect(profiled.stdoutBytes.equals(plain.stdoutBytes)).toBe(true);
    const profile = JSON.parse(profiled.stderr.trim()) as {
      phases: Record<string, { count: number }>;
      queries: unknown[];
    };
    expect(profile.phases['A:store-discovery']?.count).toBe(1);
    expect(profile.queries.length).toBeGreaterThan(0);
    expect(profiled.stderr).not.toContain('hello profile');
  });

  it('still prints the profile when the command fails', async () => {
    const fx = createSessionIntegrityFixtureRoot('cursor-history-profile-');
    fixtures.push(fx);
    const run = await runBuiltCli(['--profile', '--data-path', fx.workspaceStorage, 'show', '99'], {
      env: { CURSOR_STORE_ROOT: fx.storeRoot },
      timeoutMs: 30_000,
    });
    expect(run.status).not.toBe(0);
    const lastLine = run.stderr.trim().split('\n').pop()!;
    expect(JSON.parse(lastLine)).toHaveProperty('phases');
  });
});
