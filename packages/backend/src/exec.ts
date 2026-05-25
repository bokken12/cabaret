import { spawn } from 'node:child_process';

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

/** Cap on combined stdout+stderr bytes; runaway git commands get killed. */
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

/**
 * Spawn a process and capture stdout/stderr. Rejects on non-zero exit with
 * an `ExecError` that includes the full command and both streams.
 *
 * `cwd` defaults to the current working directory. `input` is written to
 * the child's stdin (and stdin then closed) when provided — used for git
 * plumbing like `hash-object --stdin` and `mktree`.
 *
 * Uses `spawn` rather than `execFile` because `execFile`'s `input` option
 * only exists on the sync variant; passing it to the async form silently
 * does nothing and the child hangs waiting on stdin.
 */
export async function exec(
  cmd: string,
  args: readonly string[],
  options: { cwd?: string; input?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args as string[], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let combinedBytes = 0;
    let overflowed = false;
    const collect = (sink: Buffer[]) => (c: Buffer) => {
      if (overflowed) return;
      combinedBytes += c.length;
      if (combinedBytes > MAX_OUTPUT_BYTES) {
        overflowed = true;
        child.kill();
        return;
      }
      sink.push(c);
    };
    child.stdout.on('data', collect(stdoutChunks));
    child.stderr.on('data', collect(stderrChunks));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      if (overflowed) {
        reject(
          new ExecError(
            [cmd, ...args],
            code,
            stdout,
            `${stderr}\noutput exceeded ${String(MAX_OUTPUT_BYTES)} bytes`,
          ),
        );
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new ExecError([cmd, ...args], code, stdout, stderr));
      }
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}
