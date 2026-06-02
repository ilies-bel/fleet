/**
 * Tests for the port-forward manager (gateway/src/cluster/port-forward.js).
 *
 * Strategy: every test uses createPortForwardManager(mockPortForward) so the
 * oc binary is never invoked. The mock returns { localPort, stop, exitPromise }
 * and exposes a simulateCrash() helper to trigger unexpected exit. Tests
 * assert on observable behaviour — port assignment, crash-restart, clean
 * shutdown — not on internal Maps or lock state.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPortForwardManager } from './port-forward.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a controllable mock portForward function.
 *
 * Each call gets a distinct localPort (10001, 10002, …) so tests can
 * distinguish the original forward from its restart.
 *
 * @returns {{
 *   mockPortForward: import('./port-forward.js').PortForwardFn,
 *   calls: Array<{svcName: string, ns: string, remotePort: number}>,
 *   simulateCrash(svcName: string): void,
 * }}
 */
function makeMock() {
  /** @type {Map<string, () => void>} svcName -> exitPromise resolver */
  const exitResolvers = new Map();
  /** @type {Array<{svcName: string, ns: string, remotePort: number}>} */
  const calls = [];
  let seq = 0;

  async function mockPortForward(svcName, ns, remotePort) {
    seq++;
    const localPort = 10000 + seq;
    calls.push({ svcName, ns, remotePort });

    let resolveExit;
    const exitPromise = new Promise(res => {
      resolveExit = res;
    });
    exitResolvers.set(svcName, resolveExit);

    return {
      localPort,
      stop: async () => {
        exitResolvers.delete(svcName);
      },
      exitPromise,
    };
  }

  return {
    mockPortForward,
    calls,
    simulateCrash(svcName) {
      const resolve = exitResolvers.get(svcName);
      if (resolve) resolve();
    },
  };
}

/**
 * Yield to all pending microtasks before continuing.
 * An async mock portForward resolves in microtasks, so this is enough to let
 * a full restart cycle complete (no real I/O in tests).
 */
function settle() {
  return new Promise(resolve => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// registerForward / getLocalPort
// ---------------------------------------------------------------------------

describe('registerForward + getLocalPort', () => {
  test('registerForward opens a forward and returns the assigned port', async () => {
    const { mockPortForward } = makeMock();
    const mgr = createPortForwardManager(mockPortForward);

    const port = await mgr.registerForward('alpha', 'fleet-ns');

    assert.equal(typeof port, 'number');
    assert.ok(port > 0);
  });

  test('getLocalPort returns the port for a registered key', async () => {
    const { mockPortForward } = makeMock();
    const mgr = createPortForwardManager(mockPortForward);

    const port = await mgr.registerForward('beta', 'ns');

    assert.equal(mgr.getLocalPort('beta'), port);
  });

  test('getLocalPort returns undefined for an unknown key', () => {
    const { mockPortForward } = makeMock();
    const mgr = createPortForwardManager(mockPortForward);

    assert.equal(mgr.getLocalPort('ghost'), undefined);
  });

  test('registerForward calls portForward with svc/fleet-<key>, ns, and port 80', async () => {
    const { mockPortForward, calls } = makeMock();
    const mgr = createPortForwardManager(mockPortForward);

    await mgr.registerForward('gamma', 'staging');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].svcName, 'fleet-gamma');
    assert.equal(calls[0].ns, 'staging');
    assert.equal(calls[0].remotePort, 80);
  });

  test('second registerForward for same key returns existing port without re-opening', async () => {
    const { mockPortForward, calls } = makeMock();
    const mgr = createPortForwardManager(mockPortForward);

    const port1 = await mgr.registerForward('delta', 'ns');
    const port2 = await mgr.registerForward('delta', 'ns');

    assert.equal(port1, port2);
    assert.equal(calls.length, 1);
  });

  test('multiple features can be registered independently with distinct ports', async () => {
    const { mockPortForward } = makeMock();
    const mgr = createPortForwardManager(mockPortForward);

    const portA = await mgr.registerForward('a', 'ns');
    const portB = await mgr.registerForward('b', 'ns');

    assert.notEqual(portA, portB);
    assert.equal(mgr.getLocalPort('a'), portA);
    assert.equal(mgr.getLocalPort('b'), portB);
  });
});

// ---------------------------------------------------------------------------
// unregisterForward
// ---------------------------------------------------------------------------

describe('unregisterForward', () => {
  test('unregisterForward removes the entry so getLocalPort returns undefined', async () => {
    const { mockPortForward } = makeMock();
    const mgr = createPortForwardManager(mockPortForward);

    await mgr.registerForward('epsilon', 'ns');
    await mgr.unregisterForward('epsilon');

    assert.equal(mgr.getLocalPort('epsilon'), undefined);
  });

  test('unregisterForward calls stop() on the running forward', async () => {
    let stopCalled = false;
    const mockPortForward = async () => ({
      localPort: 9000,
      stop: async () => { stopCalled = true; },
      exitPromise: new Promise(() => {}),
    });
    const mgr = createPortForwardManager(mockPortForward);

    await mgr.registerForward('zeta', 'ns');
    await mgr.unregisterForward('zeta');

    assert.ok(stopCalled, 'stop() should be called on unregister');
  });

  test('unregisterForward is a no-op for an unknown key', async () => {
    const { mockPortForward } = makeMock();
    const mgr = createPortForwardManager(mockPortForward);

    await assert.doesNotReject(mgr.unregisterForward('nonexistent'));
  });

  test('after unregisterForward the key can be re-registered', async () => {
    const { mockPortForward } = makeMock();
    const mgr = createPortForwardManager(mockPortForward);

    await mgr.registerForward('eta', 'ns');
    await mgr.unregisterForward('eta');
    const newPort = await mgr.registerForward('eta', 'ns');

    assert.equal(typeof newPort, 'number');
    assert.equal(mgr.getLocalPort('eta'), newPort);
  });
});

// ---------------------------------------------------------------------------
// crash-restart
// ---------------------------------------------------------------------------

describe('crash-restart', () => {
  test('unexpected exit triggers a restart and getLocalPort returns new port', async () => {
    const { mockPortForward, simulateCrash } = makeMock();
    const mgr = createPortForwardManager(mockPortForward);

    const firstPort = await mgr.registerForward('crashy', 'ns');
    simulateCrash('fleet-crashy');

    await settle();

    const newPort = mgr.getLocalPort('crashy');
    assert.ok(newPort !== undefined, 'feature should be re-registered after crash');
    assert.notEqual(newPort, firstPort, 'port should change after crash-restart');
  });

  test('restart opens a new forward with the same svcName, ns, and port 80', async () => {
    const { mockPortForward, calls, simulateCrash } = makeMock();
    const mgr = createPortForwardManager(mockPortForward);

    await mgr.registerForward('theta', 'prod');
    simulateCrash('fleet-theta');

    await settle();

    assert.equal(calls.length, 2);
    assert.equal(calls[1].svcName, 'fleet-theta');
    assert.equal(calls[1].ns, 'prod');
    assert.equal(calls[1].remotePort, 80);
  });

  test('getLocalPort returns undefined during the restart window then the new port after', async () => {
    let releaseRestart;
    let callCount = 0;

    const mockPortForward = async (svcName, ns, remotePort) => {
      callCount++;
      if (callCount === 2) {
        // Pause the restart so we can observe the gap
        await new Promise(res => { releaseRestart = res; });
      }
      let resolveExit;
      const exitPromise = new Promise(res => { resolveExit = res; });
      return {
        localPort: 20000 + callCount,
        stop: async () => {},
        exitPromise,
        _resolveExit: resolveExit,
      };
    };

    const mgr = createPortForwardManager(mockPortForward);

    // Register and grab first forward's crash trigger
    const result1 = await mgr.registerForward('iota', 'ns');
    assert.equal(result1, 20001);

    // Grab the exit resolver from the first call
    let firstExitResolve;
    // Rebuild mock to capture the resolver more directly
    // Simpler: re-use the approach where we hold a reference

    // Since we can't easily get firstExitResolve from the closure above,
    // let's use a different approach: verify the gap by checking immediately
    // after triggering the crash (before settle).

    // Re-run the test with a properly-captured resolver
    let resolveFirstExit;
    let callCountB = 0;
    const mockB = async () => {
      callCountB++;
      let resolveExit;
      const exitPromise = new Promise(res => { resolveExit = res; });
      if (callCountB === 1) resolveFirstExit = resolveExit;
      // Second call is blocked until releaseRestart
      if (callCountB === 2) {
        await new Promise(res => { releaseRestart = res; });
      }
      return { localPort: 30000 + callCountB, stop: async () => {}, exitPromise };
    };
    const mgr2 = createPortForwardManager(mockB);

    await mgr2.registerForward('kappa', 'ns');
    resolveFirstExit(); // trigger crash

    // Immediately after crash (before restart resolves), port is undefined
    await new Promise(res => setImmediate(res)); // one tick for onExit microtask
    assert.equal(mgr2.getLocalPort('kappa'), undefined, 'port should be undefined while restarting');

    // Release the blocked restart
    releaseRestart();
    await settle();

    assert.equal(mgr2.getLocalPort('kappa'), 30002, 'new port available after restart');
  });

  test('per-key lock: second exit fires after restart completes → both restarts succeed sequentially', async () => {
    const { mockPortForward, simulateCrash } = makeMock();
    const mgr = createPortForwardManager(mockPortForward);

    await mgr.registerForward('lambda', 'ns');
    simulateCrash('fleet-lambda'); // first crash → restart to fleet-lambda
    await settle();

    // The restart re-registered fleet-lambda; crash it again
    simulateCrash('fleet-lambda');
    await settle();

    assert.ok(mgr.getLocalPort('lambda') !== undefined, 'should survive two sequential crashes');
  });

  test('exiting after unregisterForward does not trigger a restart', async () => {
    let restartCount = 0;
    let resolveFirstExit;

    const mockPortForward = async () => {
      restartCount++;
      let resolveExit;
      const exitPromise = new Promise(res => { resolveExit = res; });
      if (restartCount === 1) resolveFirstExit = resolveExit;
      return { localPort: 40000 + restartCount, stop: async () => {}, exitPromise };
    };
    const mgr = createPortForwardManager(mockPortForward);

    await mgr.registerForward('mu', 'ns');
    await mgr.unregisterForward('mu'); // removes entry
    resolveFirstExit(); // simulate exit after unregister
    await settle();

    assert.equal(restartCount, 1, 'no restart should occur after unregister');
    assert.equal(mgr.getLocalPort('mu'), undefined);
  });
});

// ---------------------------------------------------------------------------
// drain (SIGTERM semantics)
// ---------------------------------------------------------------------------

describe('drain', () => {
  test('drain calls stop() on all active forwards', async () => {
    const stopCalls = [];
    let seq = 0;

    const mockPortForward = async () => {
      seq++;
      return {
        localPort: 50000 + seq,
        stop: async () => stopCalls.push(seq),
        exitPromise: new Promise(() => {}),
      };
    };
    const mgr = createPortForwardManager(mockPortForward);

    await mgr.registerForward('x', 'ns');
    await mgr.registerForward('y', 'ns');
    await mgr.registerForward('z', 'ns');

    await mgr.drain();

    assert.equal(stopCalls.length, 3, 'all 3 stop() calls expected');
  });

  test('drain clears the map so getLocalPort returns undefined for all keys', async () => {
    const { mockPortForward } = makeMock();
    const mgr = createPortForwardManager(mockPortForward);

    await mgr.registerForward('p', 'ns');
    await mgr.registerForward('q', 'ns');

    await mgr.drain();

    assert.equal(mgr.getLocalPort('p'), undefined);
    assert.equal(mgr.getLocalPort('q'), undefined);
  });

  test('drain prevents restarts for processes that exit after drain', async () => {
    let restartCount = 0;
    let resolveFirstExit;

    const mockPortForward = async () => {
      restartCount++;
      let resolveExit;
      const exitPromise = new Promise(res => { resolveExit = res; });
      if (restartCount === 1) resolveFirstExit = resolveExit;
      return {
        localPort: 60000 + restartCount,
        stop: async () => { resolveExit(); },
        exitPromise,
      };
    };
    const mgr = createPortForwardManager(mockPortForward);

    await mgr.registerForward('nu', 'ns');
    await mgr.drain(); // stop() fires resolveExit → exitPromise resolves

    await settle(); // give any inadvertent restart a chance to run

    assert.equal(restartCount, 1, 'no restart should happen after drain');
  });

  test('drain with no active forwards resolves immediately without error', async () => {
    const { mockPortForward } = makeMock();
    const mgr = createPortForwardManager(mockPortForward);

    await assert.doesNotReject(mgr.drain());
  });
});
