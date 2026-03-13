import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_PATH = fileURLToPath(new URL('../../.husky/pre-commit', import.meta.url));
const tempDirs: string[] = [];
const textDecoder = new TextDecoder();

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

function runCommand(args: string[], cwd: string, env?: Record<string, string>): CommandResult {
  const proc = Bun.spawnSync(args, {
    cwd,
    env: {
      ...process.env,
      ...(env ?? {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    exitCode: proc.exitCode,
    stdout: textDecoder.decode(proc.stdout).trim(),
    stderr: textDecoder.decode(proc.stderr).trim(),
  };
}

function runChecked(args: string[], cwd: string, env?: Record<string, string>): string {
  const result = runCommand(args, cwd, env);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe('');

  return result.stdout;
}

function createTestRepo(): { readonly repoDir: string; readonly env: Record<string, string> } {
  const repoDir = mkdtempSync(join(tmpdir(), 'safety-net-pre-commit-'));
  tempDirs.push(repoDir);

  runChecked(['git', 'init', '-q'], repoDir);
  runChecked(['git', 'config', 'user.email', 'test@example.com'], repoDir);
  runChecked(['git', 'config', 'user.name', 'Safety Net Test'], repoDir);
  runChecked(['git', 'config', 'core.autocrlf', 'false'], repoDir);
  runChecked(['git', 'config', 'commit.gpgsign', 'false'], repoDir);

  const stubBinDir = join(repoDir, '.test-bin');
  mkdirSync(stubBinDir);

  const stubBunPath = join(stubBinDir, 'bun');
  writeFileSync(stubBunPath, '#!/usr/bin/env sh\nexit 0\n');
  chmodSync(stubBunPath, 0o755);

  return {
    repoDir,
    env: {
      PATH: [stubBinDir, process.env.PATH ?? ''].filter(Boolean).join(delimiter),
    },
  };
}

function runPreCommit(repoDir: string, env: Record<string, string>): void {
  runChecked(['sh', HOOK_PATH], repoDir, env);
}

function distStatus(repoDir: string, env: Record<string, string>): string {
  return runChecked(
    ['git', 'status', '--porcelain', '--untracked-files=all', 'dist/'],
    repoDir,
    env,
  );
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('pre-commit dist staging', () => {
  test('temp repo disables git line-ending conversion', () => {
    const { repoDir, env } = createTestRepo();

    const result = runCommand(['git', 'config', '--local', '--get', 'core.autocrlf'], repoDir, env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('false');
    expect(result.stderr).toBe('');
  });

  test('stages newly generated untracked files in dist', () => {
    const { repoDir, env } = createTestRepo();

    mkdirSync(join(repoDir, 'dist'), { recursive: true });
    writeFileSync(join(repoDir, 'dist', 'new.js'), 'console.log("new");\n');

    runPreCommit(repoDir, env);

    expect(distStatus(repoDir, env)).toBe('A  dist/new.js');
  });

  test('stages modified tracked files in dist', () => {
    const { repoDir, env } = createTestRepo();

    mkdirSync(join(repoDir, 'dist'), { recursive: true });
    writeFileSync(join(repoDir, 'dist', 'index.js'), 'console.log("old");\n');
    runChecked(['git', 'add', '-A'], repoDir, env);
    runChecked(['git', 'commit', '-qm', 'initial'], repoDir, env);

    writeFileSync(join(repoDir, 'dist', 'index.js'), 'console.log("new");\n');

    runPreCommit(repoDir, env);

    expect(distStatus(repoDir, env)).toBe('M  dist/index.js');
  });
});
