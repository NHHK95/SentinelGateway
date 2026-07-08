'use strict';

const fs = require('fs');
const path = require('path');
const { buildPolicyLookup } = require('./engine');

const DEFAULT_POLICIES_DIR = '/app/policies';
const RELOAD_DEBOUNCE_MS = 150;

/**
 * @param {string} policiesDir
 * @returns {Promise<import('./types').PolicyDocument[]>}
 */
async function loadPolicyDocuments(policiesDir) {
  const entries = await fs.promises.readdir(policiesDir, { withFileTypes: true });
  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(policiesDir, entry.name))
    .sort();

  /** @type {import('./types').PolicyDocument[]} */
  const documents = [];

  for (const filePath of jsonFiles) {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    if (!raw.trim()) {
      continue;
    }

    const parsed = JSON.parse(raw);
    documents.push(parsed);
  }

  return documents;
}

/**
 * Atomically rebuilds and swaps the in-memory policy lookup dictionary.
 * @param {string} policiesDir
 * @param {{ current: import('./types').PolicyLookup | null }} state
 * @returns {Promise<import('./types').PolicyLookup>}
 */
async function reloadPolicyLookup(policiesDir, state) {
  const documents = await loadPolicyDocuments(policiesDir);
  const nextLookup = buildPolicyLookup(documents);

  state.current = nextLookup;
  return nextLookup;
}

/**
 * @param {Object} [options]
 * @param {string} [options.policiesDir]
 * @param {(lookup: import('./types').PolicyLookup) => void} [options.onReload]
 * @param {(error: Error) => void} [options.onError]
 * @returns {Promise<{ stop: () => Promise<void>, getLookup: () => import('./types').PolicyLookup | null }>}
 */
async function startPolicyWatcher(options = {}) {
  const policiesDir = options.policiesDir ?? DEFAULT_POLICIES_DIR;
  /** @type {{ current: import('./types').PolicyLookup | null }} */
  const state = { current: null };

  let reloadTimer = null;
  let reloadPromise = null;
  let watcher = null;
  let stopped = false;

  const scheduleReload = () => {
    if (stopped) {
      return;
    }

    if (reloadTimer) {
      clearTimeout(reloadTimer);
    }

    reloadTimer = setTimeout(async () => {
      reloadTimer = null;
      if (reloadPromise) {
        await reloadPromise;
      }

      reloadPromise = reloadPolicyLookup(policiesDir, state)
        .then((lookup) => {
          options.onReload?.(lookup);
          return lookup;
        })
        .catch((error) => {
          options.onError?.(error);
          throw error;
        })
        .finally(() => {
          reloadPromise = null;
        });

      await reloadPromise;
    }, RELOAD_DEBOUNCE_MS);
  };

  await reloadPolicyLookup(policiesDir, state);
  options.onReload?.(state.current);

  await fs.promises.mkdir(policiesDir, { recursive: true });

  watcher = fs.watch(policiesDir, { persistent: true }, (_eventType, filename) => {
    if (!filename || !filename.endsWith('.json')) {
      return;
    }
    scheduleReload();
  });

  watcher.on('error', (error) => {
    options.onError?.(error);
  });

  return {
    getLookup: () => state.current,
    stop: async () => {
      stopped = true;

      if (reloadTimer) {
        clearTimeout(reloadTimer);
        reloadTimer = null;
      }

      if (reloadPromise) {
        await reloadPromise.catch(() => undefined);
      }

      await new Promise((resolve) => {
        if (!watcher) {
          resolve();
          return;
        }
        watcher.close(() => resolve());
      });
    },
  };
}

module.exports = {
  DEFAULT_POLICIES_DIR,
  loadPolicyDocuments,
  reloadPolicyLookup,
  startPolicyWatcher,
};
