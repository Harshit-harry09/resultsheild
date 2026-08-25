'use strict';

/**
 * redlock.js — Distributed Lock Consensus Algorithm
 *
 * Implements Redlock multi-node consensus across N independent Redis nodes
 * (quorum = floor(N/2) + 1) with clock drift compensation.
 * Gracefully operates with a single Redis instance or multi-node cluster.
 */

const { v4: uuidv4 } = require('uuid');

const RELEASE_LOCK_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

class Redlock {
  /**
   * @param {Array<Redis>|Redis} clients Single client or array of independent Redis clients
   * @param {object} options
   */
  constructor(clients, options = {}) {
    this.clients = Array.isArray(clients) ? clients : [clients];
    this.driftFactor = options.driftFactor || 0.01;
    this.retryCount = options.retryCount || 1;
    this.retryDelay = options.retryDelay || 50;
  }

  get quorum() {
    return Math.floor(this.clients.length / 2) + 1;
  }

  /**
   * Attempts to acquire the lock on a single Redis node
   */
  async _lockInstance(client, resource, token, ttlMs) {
    try {
      const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
      const result = await client.set(resource, token, 'NX', 'EX', ttlSec);
      return result === 'OK';
    } catch (_err) {
      return false;
    }
  }

  /**
   * Releases lock on a single Redis node using compare-and-delete
   */
  async _unlockInstance(client, resource, token) {
    try {
      await client.eval(RELEASE_LOCK_LUA, 1, resource, token);
    } catch (_err) {
      // Best-effort unlock
    }
  }

  /**
   * Acquires distributed lock across all nodes requiring quorum
   * @param {string} resource Lock key
   * @param {number} ttlMs Lock TTL in milliseconds
   * @returns {Promise<{ resource: string, token: string, validityTime: number, release: () => Promise<void> } | null>}
   */
  async acquire(resource, ttlMs = 5000) {
    const token = uuidv4();
    const startTime = Date.now();

    const results = await Promise.all(
      this.clients.map((client) => this._lockInstance(client, resource, token, ttlMs))
    );

    const successfulLocks = results.filter(Boolean).length;
    const elapsedTime = Date.now() - startTime;
    const drift = Math.round(ttlMs * this.driftFactor) + 2;
    const validityTime = ttlMs - elapsedTime - drift;

    if (successfulLocks >= this.quorum && validityTime > 0) {
      return {
        resource,
        token,
        validityTime,
        release: async () => {
          await Promise.all(
            this.clients.map((client) => this._unlockInstance(client, resource, token))
          );
        },
      };
    }

    // Quorum failed — unlock all nodes that were successfully acquired
    await Promise.all(
      this.clients.map((client, idx) => {
        if (results[idx]) {
          return this._unlockInstance(client, resource, token);
        }
        return Promise.resolve();
      })
    );

    return null;
  }
}

module.exports = { Redlock };
