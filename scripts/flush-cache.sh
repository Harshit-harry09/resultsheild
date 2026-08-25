#!/usr/bin/env bash
# flush-cache.sh — Non-blocking flush of cached results from Redis.
# Used in Demo Part 5b to trigger the cold-start stampede demonstration.
#
# Uses SCAN-based batch UNLINK instead of blocking KEYS to prevent freezing
# the Redis event loop under high traffic.

set -euo pipefail

REDIS_HOST="${REDIS_HOST:-}"

FLUSH_SCRIPT='
local cursor = "0"
local count = 0
repeat
  local result = redis.call("SCAN", cursor, "MATCH", "cache:result:*", "COUNT", 1000)
  cursor = result[1]
  local keys = result[2]
  if #keys > 0 then
    redis.call("UNLINK", unpack(keys))
    count = count + #keys
  end
until cursor == "0"
return count
'

if [ -n "$REDIS_HOST" ]; then
  echo "[flush] Non-blocking flushing cache keys via redis-cli at $REDIS_HOST:6379"
  DELETED=$(redis-cli -h "$REDIS_HOST" -p 6379 EVAL "$FLUSH_SCRIPT" 0)
  echo "[flush] Deleted $DELETED cache keys."
else
  echo "[flush] Non-blocking flushing cache keys via docker exec (redis container)"
  DELETED=$(docker exec resultshield-redis redis-cli EVAL "$FLUSH_SCRIPT" 0)
  echo "[flush] Deleted $DELETED cache keys."
  
  REMAINING=$(docker exec resultshield-redis redis-cli DBSIZE)
  echo "[flush] Done. Remaining keys in Redis: $REMAINING"
fi

echo "[flush] Cache flushed non-blockingly. Next requests will exercise stampede protection."
echo "[flush] Watch Prometheus: stampede_lock_wait_total should spike,"
echo "         while Postgres query rate stays flat (one query per key, not N)."
