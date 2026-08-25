#!/usr/bin/env python3
"""
autoscaler.py — ResultShield local autoscaler
Runs on the HOST (not in a container), polls Prometheus, scales via docker compose.

Rules (rules.md Section 5, techspec.md Section 9):
  load_ratio = in_flight_requests / (current_replicas × TARGET_IN_FLIGHT_PER_REPLICA)
  > 0.70  → scale up   (non-overlapping upper bound)
  < 0.30  → scale down (non-overlapping lower bound)
  0.30–0.70 → maintain  (no overlap, no gap)

CRITICAL ordering: graceful shutdown (shutdown.js, M9) must exist BEFORE this
autoscaler is run, because `docker compose up -d --scale backend=N` (N smaller)
sends SIGTERM to the excess containers. Without the shutdown handler, that SIGTERM
drops in-flight requests. (implementationplan.md M9 ordering rule)
"""

import subprocess
import time
import urllib.request
import urllib.error
import json
import os
import sys
import logging

# ─── Config ──────────────────────────────────────────────────────────────────
PROMETHEUS_URL           = os.environ.get("PROMETHEUS_URL", "http://localhost:9090")
MIN_REPLICAS             = int(os.environ.get("MIN_REPLICAS", "1"))
MAX_REPLICAS             = int(os.environ.get("MAX_REPLICAS", "16"))
TARGET_IN_FLIGHT         = int(os.environ.get("TARGET_IN_FLIGHT_PER_REPLICA", "100"))
POLL_INTERVAL_SECONDS    = int(os.environ.get("AUTOSCALER_POLL_INTERVAL_SECONDS", "5"))
SCALE_UP_THRESHOLD       = float(os.environ.get("SCALE_UP_THRESHOLD", "0.70"))
SCALE_DOWN_THRESHOLD     = float(os.environ.get("SCALE_DOWN_THRESHOLD", "0.30"))
COMPOSE_PROJECT_DIR      = os.environ.get("COMPOSE_PROJECT_DIR", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Cooldown: don't scale again within N seconds of the last scaling event
SCALE_COOLDOWN_SECONDS   = int(os.environ.get("SCALE_COOLDOWN_SECONDS", "15"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [autoscaler] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("autoscaler")


def query_prometheus(metric_query: str) -> float | None:
    """Query Prometheus instant vector and return the scalar value."""
    url = f"{PROMETHEUS_URL}/api/v1/query?query={urllib.request.quote(metric_query)}"
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            results = data.get("data", {}).get("result", [])
            if results:
                return float(results[0]["value"][1])
            return 0.0
    except urllib.error.URLError as e:
        log.warning(f"Prometheus unreachable: {e}")
        return None
    except Exception as e:
        log.warning(f"Query failed ({metric_query}): {e}")
        return None


def get_current_replica_count() -> int:
    """Count running backend containers via docker compose ps."""
    try:
        result = subprocess.run(
            ["docker", "compose", "ps", "--quiet", "backend"],
            capture_output=True, text=True, cwd=COMPOSE_PROJECT_DIR, timeout=10
        )
        # Each line is one container ID
        ids = [line.strip() for line in result.stdout.strip().splitlines() if line.strip()]
        return max(len(ids), 0)
    except Exception as e:
        log.warning(f"Could not get replica count: {e}")
        return -1


def scale_backend(new_count: int):
    """Scale backend to new_count replicas via docker compose."""
    log.info(f"Running: docker compose up -d --scale backend={new_count}")
    try:
        subprocess.run(
            ["docker", "compose", "up", "-d", "--scale", f"backend={new_count}", "--no-recreate"],
            cwd=COMPOSE_PROJECT_DIR,
            check=True,
            timeout=60,
        )
        log.info(f"Scale command completed: backend → {new_count}")
    except subprocess.CalledProcessError as e:
        log.error(f"Scale failed: {e}")
    except Exception as e:
        log.error(f"Scale error: {e}")


def main():
    log.info("=== ResultShield Autoscaler starting ===")
    log.info(f"  MIN_REPLICAS={MIN_REPLICAS}, MAX_REPLICAS={MAX_REPLICAS}")
    log.info(f"  TARGET_IN_FLIGHT_PER_REPLICA={TARGET_IN_FLIGHT}")
    log.info(f"  Scale up threshold:   > {SCALE_UP_THRESHOLD:.0%}")
    log.info(f"  Scale down threshold: < {SCALE_DOWN_THRESHOLD:.0%}")
    log.info(f"  Poll interval: {POLL_INTERVAL_SECONDS}s")
    log.info(f"  Project dir: {COMPOSE_PROJECT_DIR}")
    log.info("Thresholds are non-overlapping: >70% up, <30% down, 30-70% maintain")

    last_scale_time = 0.0

    while True:
        try:
            # ── Query in-flight requests from Prometheus ──────────────────
            in_flight = query_prometheus("sum(http_requests_in_flight)")
            if in_flight is None:
                log.warning("Skipping cycle — Prometheus not reachable")
                time.sleep(POLL_INTERVAL_SECONDS)
                continue

            current_replicas = get_current_replica_count()
            if current_replicas < 0:
                log.warning("Skipping cycle — could not determine replica count")
                time.sleep(POLL_INTERVAL_SECONDS)
                continue

            if current_replicas == 0:
                current_replicas = 1  # avoid division by zero

            # ── Compute load ratio ────────────────────────────────────────
            denominator = current_replicas * TARGET_IN_FLIGHT
            load_ratio = in_flight / denominator if denominator > 0 else 0.0

            log.info(
                f"in_flight={in_flight:.0f}  replicas={current_replicas}  "
                f"load_ratio={load_ratio:.2f}  "
                f"(capacity={denominator})"
            )

            # ── Check cooldown ─────────────────────────────────────────────
            now = time.time()
            in_cooldown = (now - last_scale_time) < SCALE_COOLDOWN_SECONDS

            # ── Scaling decision (non-overlapping thresholds) ──────────────
            if load_ratio > SCALE_UP_THRESHOLD and current_replicas < MAX_REPLICAS:
                if not in_cooldown:
                    new_count = min(current_replicas + 1, MAX_REPLICAS)
                    log.info(f"SCALE UP: {current_replicas} → {new_count}  (load_ratio={load_ratio:.2f} > {SCALE_UP_THRESHOLD})")
                    scale_backend(new_count)
                    last_scale_time = now
                else:
                    log.info(f"Scale up suppressed (cooldown, {SCALE_COOLDOWN_SECONDS - (now - last_scale_time):.0f}s remaining)")

            elif load_ratio < SCALE_DOWN_THRESHOLD and current_replicas > MIN_REPLICAS:
                if not in_cooldown:
                    new_count = max(current_replicas - 1, MIN_REPLICAS)
                    log.info(f"SCALE DOWN: {current_replicas} → {new_count}  (load_ratio={load_ratio:.2f} < {SCALE_DOWN_THRESHOLD})")
                    # SIGTERM is sent to the excess container by docker compose.
                    # shutdown.js handles it: health flag → drain → close → exit
                    scale_backend(new_count)
                    last_scale_time = now
                else:
                    log.info(f"Scale down suppressed (cooldown, {SCALE_COOLDOWN_SECONDS - (now - last_scale_time):.0f}s remaining)")

            else:
                # 0.30 ≤ load_ratio ≤ 0.70 → maintain (no overlap, no gap)
                log.info(f"MAINTAIN at {current_replicas} replicas  (load_ratio={load_ratio:.2f} in [{SCALE_DOWN_THRESHOLD}, {SCALE_UP_THRESHOLD}])")

        except KeyboardInterrupt:
            log.info("Autoscaler stopped by user")
            sys.exit(0)
        except Exception as e:
            log.error(f"Unexpected error in loop: {e}")

        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
