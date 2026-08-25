'use strict';

/**
 * circuitBreaker.js — Database Bulkheading and Circuit Breaker
 *
 * Implements:
 * 1. Bulkhead (Concurrency Limiter / Semaphore):
 *    Caps concurrent in-flight queries to PostgreSQL to protect connection pools.
 * 2. Circuit Breaker (State Machine: CLOSED, OPEN, HALF_OPEN):
 *    Trips fast on sustained database errors/timeouts to prevent cascading failures
 *    and allows serving stale cached data as fallback.
 */

const STATE = {
  CLOSED:    'CLOSED',
  OPEN:      'OPEN',
  HALF_OPEN: 'HALF_OPEN',
};

class Bulkhead {
  constructor(maxConcurrent = 10, maxQueue = 100) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
    this.activeCount = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++;
      try {
        return await fn();
      } finally {
        this.activeCount--;
        this._processNext();
      }
    }

    if (this.queue.length >= this.maxQueue) {
      const err = new Error('Bulkhead queue limit exceeded');
      err.statusCode = 503;
      throw err;
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
    });
  }

  _processNext() {
    if (this.queue.length > 0 && this.activeCount < this.maxConcurrent) {
      const next = this.queue.shift();
      this.activeCount++;
      (async () => {
        try {
          const res = await next.fn();
          next.resolve(res);
        } catch (err) {
          next.reject(err);
        } finally {
          this.activeCount--;
          this._processNext();
        }
      })();
    }
  }
}

class CircuitBreaker {
  constructor(options = {}) {
    this.name = options.name || 'db-circuit-breaker';
    this.timeoutMs = options.timeoutMs || 1000;
    this.resetTimeoutMs = options.resetTimeoutMs || 10000;
    this.errorThresholdPct = options.errorThresholdPct || 50;
    this.volumeThreshold = options.volumeThreshold || 5;
    this.maxConcurrent = options.maxConcurrent || 10;

    this.state = STATE.CLOSED;
    this.lastStateChange = Date.now();
    this.bulkhead = new Bulkhead(this.maxConcurrent, 100);

    this.window = []; // rolling window of boolean results (true = success, false = failure)
    this.windowSize = 20;
  }

  _record(success) {
    this.window.push(success);
    if (this.window.length > this.windowSize) {
      this.window.shift();
    }

    if (this.state === STATE.CLOSED && this.window.length >= this.volumeThreshold) {
      const failures = this.window.filter((s) => !s).length;
      const failureRate = (failures / this.window.length) * 100;
      if (failureRate >= this.errorThresholdPct) {
        this._transitionTo(STATE.OPEN);
      }
    }
  }

  _transitionTo(newState) {
    console.warn(`[circuit-breaker:${this.name}] Transition: ${this.state} -> ${newState}`);
    this.state = newState;
    this.lastStateChange = Date.now();
    this.window = [];
  }

  async execute(fn, fallbackFn = null) {
    const now = Date.now();

    // Check if OPEN circuit should transition to HALF_OPEN for probe trial
    if (this.state === STATE.OPEN) {
      if (now - this.lastStateChange >= this.resetTimeoutMs) {
        this._transitionTo(STATE.HALF_OPEN);
      } else {
        if (fallbackFn) {
          return await fallbackFn(new Error(`Circuit is OPEN (${this.name})`));
        }
        const err = new Error(`Circuit breaker is OPEN (${this.name})`);
        err.statusCode = 503;
        throw err;
      }
    }

    // Execute through bulkhead and timeout wrapper
    try {
      const result = await this.bulkhead.run(async () => {
        return await Promise.race([
          fn(),
          new Promise((_, reject) => {
            setTimeout(() => {
              const err = new Error(`Query timeout after ${this.timeoutMs}ms (${this.name})`);
              err.statusCode = 504;
              reject(err);
            }, this.timeoutMs);
          }),
        ]);
      });

      this._record(true);
      if (this.state === STATE.HALF_OPEN) {
        this._transitionTo(STATE.CLOSED);
      }
      return result;
    } catch (err) {
      this._record(false);
      if (this.state === STATE.HALF_OPEN) {
        this._transitionTo(STATE.OPEN);
      }

      if (fallbackFn) {
        return await fallbackFn(err);
      }
      throw err;
    }
  }
}

module.exports = { CircuitBreaker, Bulkhead, STATE };
