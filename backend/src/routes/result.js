'use strict';

const express      = require('express');
const rateLimit    = require('express-rate-limit');
const cache        = require('../lib/cache');
const queue        = require('../lib/queue');
const metrics      = require('../lib/metrics');

const router = express.Router();

// ─── Config ───────────────────────────────────────────────────────────────────
const RATE_LIMIT_UNAUTHENTICATED_RPM = parseInt(
  process.env.RATE_LIMIT_UNAUTHENTICATED_RPM || '20', 10
);

// ─── Roll-number validation ───────────────────────────────────────────────────
const ROLL_NUMBER_RE = /^[0-9]{8}$/;

// ─── Rate limiter — disabled per user request for benchmark / load testing ───
const tokenAwareRateLimiter = (_req, _res, next) => next();

// ─── GET /api/result/:rollNumber ─────────────────────────────────────────────
router.get(
  '/result/:rollNumber',
  tokenAwareRateLimiter,
  async (req, res) => {
    const { rollNumber } = req.params;
    const sessionToken   = req.headers['x-session-token'] || null;

    // ── Validate roll number format ──────────────────────────────────────────
    if (!ROLL_NUMBER_RE.test(rollNumber)) {
      return res.status(400).json({
        status:  'error',
        message: 'Invalid roll number format. Must be exactly 8 digits.',
      });
    }

    // Track in-flight requests for the autoscaler's load ratio
    metrics.inFlightGauge.inc();

    try {
      // ── Queue admission check ────────────────────────────────────────────
      // Decides: ADMIT (serve) or QUEUE (return 202) atomically
      const admission = await queue.handleRequest(req.redis, sessionToken);

      if (admission.queued) {
        return res.status(202).json({
          status:              'queued',
          sessionToken:        admission.sessionToken,
          position:            admission.position,
          estimatedWaitSeconds: admission.estimatedWaitSeconds,
        });
      }

      // ── Serve the result (cache-aside with stampede protection) ──────────
      try {
        let result;
        try {
          result = await cache.getResult(req.pool, req.redis, rollNumber);
        } catch (cacheErr) {
          if (cacheErr.statusCode === 503) {
            return res.status(503).json({
              status:  'error',
              message: cacheErr.message || 'System busy. Please retry shortly.',
            });
          }
          throw cacheErr;
        }

        if (!result) {
          // Roll number not found in DB (e.g. sentinel 26099999)
          return res.status(200).json({
            status:  'error',
            message: 'Roll number not found',
          });
        }

        return res.status(200).json({
          status: 'ok',
          cache:  result._cacheHit ? 'hit' : 'miss',
          data: {
            rollNumber:   result.roll_number,
            name:         result.name,
            course:       result.course,
            marks:        result.marks,
            total:        result.total,
            percentage:   parseFloat(result.percentage),
            resultStatus: result.status,
          },
        });
      } finally {
        // Always release admitted slot when the request completes
        await queue.onRequestComplete(req.redis, admission.sessionToken);
      }
    } finally {
      metrics.inFlightGauge.dec();
    }
  }
);

module.exports = router;
