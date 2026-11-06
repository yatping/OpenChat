/** How the CLI runs Wrangler. Shared by `oc deploy` and `oc relay`. */
import { execFileSync } from 'node:child_process';

export type RunWrangler = (args: string[], options?: { input?: string; ci?: boolean }) => string;

/** Always the project's pinned Wrangler, run from `pkg`. Output is captured, so that it can be searched and kept quiet. */
export const wranglerIn =
  (root: string, pkg: string): RunWrangler =>
  (args, options = {}) =>
    execFileSync('pnpm', ['--filter', pkg, 'exec', 'wrangler', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.input === undefined ? {} : { input: options.input }),
      env: { ...process.env, ...(options.ci ? { CI: 'true' } : {}) },
    });

export const describeFailure = (error: unknown) => {
  const failure = error as { stderr?: string; stdout?: string; message: string };
  return `${failure.stderr ?? ''}${failure.stdout ?? ''}` || failure.message;
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates one resource. A name that already exists stops the run, so that a deployment never adopts
 * something it did not create. The Queues API has returned an unexplained error 10013 for a valid request,
 * so creation retries.
 */
export async function createResource(wrangler: RunWrangler, label: string, args: string[], wait: (ms: number) => Promise<unknown> = sleep): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return wrangler(args);
    } catch (error) {
      const detail = describeFailure(error);
      if (/already exists|already taken|11009|10026/i.test(detail)) {
        throw new Error(`${label} already exists, and this deployment did not create it. Choose another name.`, { cause: error });
      }
      if (attempt >= 4) throw new Error(`Could not create ${label}:\n${detail}`, { cause: error });
      await wait(5000 * attempt);
    }
  }
}

export const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
