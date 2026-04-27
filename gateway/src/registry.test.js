/**
 * Tests for registry.js — updateStatus activeFeature clearing behaviour,
 * and persistence of the active feature across restarts.
 *
 * Uses Node.js built-in test runner (node:test).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  register,
  unregister,
  getAll,
  updateStatus,
  getActiveFeature,
  setActiveFeature,
  isRegistered,
  loadPersistedActive,
} from './registry.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function clearRegistry() {
  for (const f of getAll()) unregister(f.key);
}

// ── updateStatus activeFeature clearing ───────────────────────────────────────

describe('updateStatus — activeFeature clearing', () => {
  beforeEach(() => {
    clearRegistry();
  });

  test('updateStatus(key, "stopped") clears activeFeature when key is active', () => {
    register('p', 'a', 'main', null, 'up');
    // register auto-activates first 'up' feature
    assert.equal(getActiveFeature(), 'p-a', 'precondition: feature should be active');

    updateStatus('p-a', 'stopped');

    assert.equal(getActiveFeature(), null, 'activeFeature should be null after stopped transition');
  });

  test('updateStatus(key, "failed") clears activeFeature when key is active', () => {
    register('p', 'b', 'main', null, 'up');
    assert.equal(getActiveFeature(), 'p-b', 'precondition: feature should be active');

    updateStatus('p-b', 'failed', 'some error');

    assert.equal(getActiveFeature(), null, 'activeFeature should be null after failed transition');
  });

  test('updateStatus(key, "building") does NOT clear activeFeature', () => {
    register('p', 'c', 'main', null, 'up');
    assert.equal(getActiveFeature(), 'p-c', 'precondition: feature should be active');

    updateStatus('p-c', 'building');

    assert.equal(getActiveFeature(), 'p-c', 'activeFeature must NOT be cleared on building transition');
  });

  test('updateStatus does NOT clear activeFeature when a different key is active', () => {
    register('p', 'd', 'main', null, 'up');  // becomes active
    register('p', 'e', 'main', null, 'up');  // second one, first stays active

    assert.equal(getActiveFeature(), 'p-d', 'precondition: p-d should be active');

    // Stop p-e (which is NOT active)
    updateStatus('p-e', 'stopped');

    assert.equal(getActiveFeature(), 'p-d', 'activeFeature should remain p-d when a non-active feature stops');
  });

  test('updateStatus(key, "stopped") on non-active feature leaves activeFeature intact', () => {
    register('p', 'f', 'main', null, 'up');
    register('p', 'g', 'main', null, 'up');
    setActiveFeature('p-f');

    updateStatus('p-g', 'stopped');

    assert.equal(getActiveFeature(), 'p-f', 'activeFeature should remain unchanged when non-active feature stops');
  });
});

// ── persistence helpers ───────────────────────────────────────────────────────

/**
 * Run a sub-test with FLEET_STATE_FILE pointed at a temp file.
 * Returns { stateFile, tmpDir } so callers can read / assert on the file.
 */
function withTempStateFile(fn) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'fleet-test-'));
  const stateFile = join(tmpDir, 'active.json');
  const original = process.env.FLEET_STATE_FILE;
  process.env.FLEET_STATE_FILE = stateFile;
  try {
    fn({ stateFile, tmpDir });
  } finally {
    if (original === undefined) {
      delete process.env.FLEET_STATE_FILE;
    } else {
      process.env.FLEET_STATE_FILE = original;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── persistence: setActiveFeature writes the file ────────────────────────────

describe('persistence — setActiveFeature', () => {
  beforeEach(() => { for (const f of getAll()) unregister(f.key); });
  afterEach(() => { for (const f of getAll()) unregister(f.key); });

  test('setActiveFeature writes key to state file', () => {
    withTempStateFile(({ stateFile }) => {
      register('p', 'h', 'main', null, 'up');
      // Registry auto-activates p-h on register; reset to test setActiveFeature directly.
      register('p', 'i', 'main', null, 'up');
      setActiveFeature('p-i');

      assert.ok(existsSync(stateFile), 'state file must exist after setActiveFeature');
      const data = JSON.parse(readFileSync(stateFile, 'utf8'));
      assert.equal(data.key, 'p-i', 'state file must record the activated key');
      assert.ok(typeof data.updatedAt === 'string', 'state file must include updatedAt');
    });
  });

  test('setActiveFeature uses atomic tmp+rename (no .tmp file left behind)', () => {
    withTempStateFile(({ stateFile }) => {
      register('p', 'j', 'main', null, 'up');
      setActiveFeature('p-j');

      assert.ok(existsSync(stateFile), 'final file must exist');
      assert.equal(existsSync(`${stateFile}.tmp`), false, '.tmp file must not remain after atomic write');
    });
  });
});

// ── persistence: register() auto-pick writes the file ────────────────────────

describe('persistence — register() auto-pick', () => {
  beforeEach(() => { for (const f of getAll()) unregister(f.key); });
  afterEach(() => { for (const f of getAll()) unregister(f.key); });

  test('first up registration persists the auto-chosen key', () => {
    withTempStateFile(({ stateFile }) => {
      register('p', 'k', 'main', null, 'up');

      assert.ok(existsSync(stateFile), 'state file must exist after auto-pick in register()');
      const data = JSON.parse(readFileSync(stateFile, 'utf8'));
      assert.equal(data.key, 'p-k', 'auto-pick must be persisted');
    });
  });

  test('second up registration does NOT overwrite the persisted key', () => {
    withTempStateFile(({ stateFile }) => {
      register('p', 'l', 'main', null, 'up');  // becomes active, persisted
      register('p', 'm', 'main', null, 'up');  // NOT active — first stays

      const data = JSON.parse(readFileSync(stateFile, 'utf8'));
      assert.equal(data.key, 'p-l', 'only the first auto-pick should be persisted');
    });
  });
});

// ── loadPersistedActive ───────────────────────────────────────────────────────

describe('loadPersistedActive', () => {
  beforeEach(() => { for (const f of getAll()) unregister(f.key); });
  afterEach(() => { for (const f of getAll()) unregister(f.key); });

  test('returns null when file does not exist', () => {
    withTempStateFile(() => {
      // stateFile was never written — loadPersistedActive reads from FLEET_STATE_FILE
      const result = loadPersistedActive();
      assert.equal(result, null);
    });
  });

  test('returns null for malformed JSON', () => {
    withTempStateFile(({ stateFile }) => {
      writeFileSync(stateFile, 'not-valid-json', 'utf8');
      const result = loadPersistedActive();
      assert.equal(result, null);
    });
  });

  test('returns key string from valid file', () => {
    withTempStateFile(() => {
      register('p', 'n', 'main', null, 'up');  // triggers persistActive → writes stateFile
      const key = loadPersistedActive();
      assert.equal(key, 'p-n');
    });
  });

  test('returns null when key field is absent from JSON', () => {
    withTempStateFile(({ stateFile }) => {
      writeFileSync(stateFile, JSON.stringify({ updatedAt: new Date().toISOString() }), 'utf8');
      const result = loadPersistedActive();
      assert.equal(result, null);
    });
  });

  test('returns null when key field is empty string', () => {
    withTempStateFile(({ stateFile }) => {
      writeFileSync(stateFile, JSON.stringify({ key: '', updatedAt: new Date().toISOString() }), 'utf8');
      const result = loadPersistedActive();
      assert.equal(result, null);
    });
  });
});
