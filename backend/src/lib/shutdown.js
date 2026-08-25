'use strict';

/**
 * shutdown.js — Graceful SIGTERM handling with zero-downtime Traefik deregistration
 *
 * Sequence:
 *   1. flip healthFlag = false        → /health returns 503 immediately
 *   2. wait DEREGISTRATION_DELAY_MS   → wait 6s for Traefik (5s interval) to poll /health
 *                                       and stop forwarding new traffic to this replica
 *   3. httpServer.close()             → stop accepting new TCP connections
 *   4. wait up to SHUTDOWN_GRACE_MS   → allow remaining in-flight requests to complete
 *   5. close Redis client & DB pool
 *   6. process.exit(0)
 */

const SHUTDOWN_GRACE_MS = parseInt(process.env.SHUTDOWN_GRACE_MS || '10000', 10);
const DEREGISTRATION_DELAY_MS = 6000; // 6 seconds covers Traefik's 5s health-check interval

/**
 * init({ server, pool, redis, healthRef })
 *
 * healthRef must expose a setter: { set healthy(v) { ... } }
 */
function init({ server, pool, redis, healthRef }) {
  let isShuttingDown = false;

  const handleShutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log('[shutdown] SIGTERM received — beginning zero-downtime graceful shutdown');

    // ── Step 1: flip health flag FIRST ──────────────────────────────────
    healthRef.healthy = false;
    console.log(`[shutdown] /health now returns 503 — waiting ${DEREGISTRATION_DELAY_MS}ms for Traefik deregistration...`);

    // ── Step 2: wait for Traefik to observe 503 and deregister replica ───
    await new Promise((resolve) => setTimeout(resolve, DEREGISTRATION_DELAY_MS));

    // ── Step 3: stop accepting new connections and drain existing ones ───
    console.log('[shutdown] Closing HTTP server socket to drain remaining in-flight requests...');
    server.close(async () => {
      console.log('[shutdown] HTTP server closed — all in-flight requests drained');

      // ── Steps 5: close clients ──────────────────────────────────────
      try {
        await redis.quit();
        console.log('[shutdown] Redis client closed');
      } catch (err) {
        console.error('[shutdown] Redis close error:', err.message);
      }

      try {
        await pool.end();
        console.log('[shutdown] DB pool closed');
      } catch (err) {
        console.error('[shutdown] DB pool close error:', err.message);
      }

      // ── Step 6: exit ──────────────────────────────────────────────────
      console.log('[shutdown] Exiting cleanly');
      process.exit(0);
    });

    // ── Step 4: enforce hard-kill fallback grace period ──────────────────
    setTimeout(() => {
      console.error(`[shutdown] Grace period (${SHUTDOWN_GRACE_MS}ms) expired — forcing exit`);
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
  };

  process.on('SIGTERM', handleShutdown);

  // Also handle SIGINT (Ctrl-C in dev) the same way
  process.on('SIGINT', handleShutdown);
}

module.exports = { init };
