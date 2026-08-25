'use strict';

const client = require('prom-client');

/**
 * metrics.js — Custom Prometheus metrics via prom-client
 *
 * Custom metrics (techspec.md Section 5):
 *   http_requests_in_flight   gauge   — used by autoscaler for load ratio
 *   cache_hit_total           counter
 *   cache_miss_total          counter
 *   stampede_lock_wait_total  counter — times a request had to wait on another's DB fetch
 *   queue_depth               gauge   — read from ZCARD queue:waiting
 *   queue_admitted_total      counter
 *
 * Grafana panel queries (techspec.md Section 10.2):
 *   rate(http_requests_total[30s])
 *   histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[30s]))
 *   rate(http_requests_total{status=~"5.."}[30s])
 *   cache_hit_total / (cache_hit_total + cache_miss_total)
 *   rate(stampede_lock_wait_total[30s])
 *   count(up{job="resultshield-backend"})
 *   queue_depth
 */

let _register = null;

// Exposed metric objects — populated by init()
const metrics = {
  inFlightGauge:            null,
  cacheHitCounter:          null,
  cacheMissCounter:         null,
  stampedeLockWaitCounter:  null,
  queueDepthGauge:          null,
  queueAdmittedCounter:     null,
  requestDurationHistogram: null,
  requestCounter:           null,
};

function init(register) {
  _register = register;

  metrics.inFlightGauge = new client.Gauge({
    name:       'http_requests_in_flight',
    help:       'Number of requests currently being processed',
    registers:  [register],
  });

  metrics.cacheHitCounter = new client.Counter({
    name:      'cache_hit_total',
    help:      'Total Redis cache hits',
    registers: [register],
  });

  metrics.cacheMissCounter = new client.Counter({
    name:      'cache_miss_total',
    help:      'Total Redis cache misses',
    registers: [register],
  });

  metrics.stampedeLockWaitCounter = new client.Counter({
    name:      'stampede_lock_wait_total',
    help:      'Times a request had to wait on another request\'s in-flight DB fetch',
    registers: [register],
  });

  metrics.queueDepthGauge = new client.Gauge({
    name:      'queue_depth',
    help:      'Current number of sessions in the virtual waiting queue',
    registers: [register],
  });

  metrics.queueAdmittedCounter = new client.Counter({
    name:      'queue_admitted_total',
    help:      'Total sessions admitted from the queue',
    registers: [register],
  });

  metrics.requestDurationHistogram = new client.Histogram({
    name:      'http_request_duration_seconds',
    help:      'HTTP request duration in seconds',
    buckets:   [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [register],
  });

  metrics.requestCounter = new client.Counter({
    name:       'http_requests_total',
    help:       'Total HTTP requests',
    labelNames: ['method', 'path', 'status'],
    registers:  [register],
  });
}

module.exports = metrics;
module.exports.init = init;
