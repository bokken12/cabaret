import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ExecResult = {
  readonly stdout: string;
  readonly stderr: string;
};

export class ExecError extends Error {
  override readonly name = 'ExecError';
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(command: readonly string[], exitCode: number | null, stdout: string, stderr: string) {
    super(`${command.join(' ')} exited with ${String(exitCode)}: ${stderr.trim() || stdout.trim()}`);
    this.command = command;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * Spawn a process and capture stdout/stderr. Rejects on non-zero exit with
 * an `ExecError` that includes the full command and both streams.
 *
 * `cwd` defaults to the current working directory. `input` is written to
 * the child's stdin if provided (for git plumbing that reads object data).
 */
export async function exec(
  cmd: string,
  args: readonly string[],
  options: { cwd?: string; input?: string } = {},
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args as string[], {
      cwd: options.cwd,
      // 50 MB is well above any single file or tree dump we'd issue.
      maxBuffer: 50 * 1024 * 1024,
      ...(options.input !== undefined ? { input: options.input } : {}),
    });
    return { stdout, stderr };
  } catch (err) {
    if (err instanceof Error && 'code' in err) {
      const e = err as Error & { code?: number | null; stdout?: string; stderr?: string };
      throw new ExecError(
        [cmd, ...args],
        e.code ?? null,
        e.stdout ?? '',
        e.stderr ?? '',
      );
    }
    throw err;
  }
}
