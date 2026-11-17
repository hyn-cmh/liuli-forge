// Process entry for the forge.
//
// The box this runs in is driven by a coordinating environment process.
// My whole job is the handshake around the real work: stand the app
// server up on whatever port the kernel hands out, tell the environment
// where the server landed, and then stay out of the way until the
// environment declares the run finished.

import { createApp } from './app.ts';

// Where the environment listens. A run without it has nobody to check in
// with, so there is nothing useful this process could do.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  console.error('main: MAKEFUN_ENV_URL missing, no environment to register with');
  process.exit(1);
}

// Handshake retries space themselves out: a short wait at first, doubling
// after each failure up to a ceiling, so a slow-starting environment is
// not hammered and a healthy one is not kept waiting either.
const FIRST_WAIT_MS = 250;
const LONGEST_WAIT_MS = 2_000;
// No single handshake request may hang longer than this; past it the
// attempt counts as failed and the retry logic takes over.
const REQUEST_DEADLINE_MS = 30_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// How long to pause after the given number of consecutive failures.
function waitAfter(failures: number): number {
  return Math.min(LONGEST_WAIT_MS, FIRST_WAIT_MS * 2 ** Math.min(failures, 8));
}

// Send the bound port over until the environment takes it. A 409 only
// means some earlier process checked in first, which counts as success
// from where I stand. A 400 or 405, though, says the environment rejects
// the shape of the request itself, and retrying that would never help, so
// it is reported as fatal instead. Everything else is worth retrying.
async function checkIn(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const reply = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`register refused with HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
      // Environment not reachable yet; fall through and try again.
    }
    await wait(waitAfter(failures));
  }
}

// Ask the environment whether the run is over, forever if need be. It
// replies {"done": false} while work is still going, so a non-answer or
// a "false" both just mean: ask again shortly.
async function awaitFinish(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const reply = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
      });
      if (reply.ok) {
        const state = (await reply.json()) as { done?: unknown };
        if (state.done === true) return;
      }
    } catch {
      // Poll failed; the run is not over as far as I know.
    }
    await wait(waitAfter(failures));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server came up without a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
  console.log(`main: forge listening on port ${boundPort}`);

  await checkIn(boundPort);
  console.log('main: checked in, waiting for the environment to finish');

  await awaitFinish();
  server.close();
  console.log('main: environment finished, shutting down');
}

run().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`main: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
