# ResultShield

> **"Don't stop the traffic. Make the system survive it."**

A zero-cost, locally deployable resilience platform demonstrating how examination-result portals can survive predictable flash-crowd traffic. ResultShield implements load balancing, Redis caching with stampede protection, horizontal scaling, monitoring, rate limiting, and a virtual waiting room — all running on a single machine.

## 🌟 Key Features

- **Stampede Protection**: Redis cache-aside with a distributed lock mechanism (4500ms max wait) to prevent database saturation during sudden cache expiration.
- **Virtual Waiting Room**: Centralized queue state managed in Redis to admit users gracefully under extreme load without overwhelming the backend.
- **Horizontal Autoscaling**: Python-based autoscaler continuously polls Prometheus metrics to dynamically scale backend Docker replicas based on real-time traffic.
- **Rate Limiting**: Fair usage limits for new sessions, completely bypassing rate limits for authenticated queue polling.
- **Comprehensive Observability**: Full integration with Prometheus, Grafana, and cAdvisor to visualize traffic, error rates, latencies, and resource consumption.
- **Graceful Degradation & Shutdown**: Handles `SIGTERM` gracefully, draining in-flight requests before shutting down replicas during scale-down.

## 🛠 Tech Stack

- **Frontend**: React + Vite (Custom Design System, State Machine for polling)
- **Backend**: Node.js + Express
- **Database**: PostgreSQL (with PgBouncer for efficient connection pooling)
- **Cache & Queue State**: Redis (Shared state for queues and stampede locks across replicas)
- **Reverse Proxy / Load Balancer**: Traefik (Auto-discovers and routes to scaling Docker replicas)
- **Monitoring & Metrics**: Prometheus, Grafana, cAdvisor
- **Load Testing**: k6 (Custom profiles for normal, heavy, result-day, and extreme traffic)

## Architecture

```
              k6 (load generator)
                     │
                  Traefik  ←── Docker provider (auto-discovers replicas)
                     │
         ┌───────────┼───────────┐
         ↓           ↓           ↓
      Backend     Backend     Backend   (expose: [3000] only — no host port)
         └───────────┼───────────┘
                     │
                   Redis   ←── cache + centralized queue state
                     │
                PgBouncer
                     │
               PostgreSQL
    
    Backend → Prometheus (docker_sd_configs) → Grafana
```

## Quick Start

### Prerequisites

- Docker Desktop
- Node.js 20+
- k6 (`choco install k6` or `winget install k6`)
- Python 3.10+ (for autoscaler)

### Setup

```bash
git clone <repo>
cd resultshield

# 1. Start infrastructure (wait for healthy status)
docker compose up -d postgres redis pgbouncer prometheus grafana cadvisor traefik

# 2. Seed database (MUST run before prewarm)
node db/seed/generate-synthetic-results.js

# 3. Pre-warm Redis cache (48h TTL)
node scripts/prewarm-cache.js

# 4. Start backend + frontend
docker compose up -d --build backend frontend

# 5. Scale backend to 3 replicas
docker compose up -d --scale backend=3
```

### URLs

| Service | URL |
|---|---|
| App | http://localhost |
| Traefik Dashboard | http://localhost:8080 |
| Grafana | http://localhost:3001 (admin/admin) |
| Prometheus | http://localhost:9090 |
| cAdvisor | http://localhost:8081 |

### Load Testing

```bash
# Generate k6 data file first
node k6/generate-data.js

k6 run k6/normal.js       # 100 VUs  — sanity check
k6 run k6/heavy.js        # 1,000 VUs — triggers autoscaler
k6 run k6/result-day.js   # 5,000 VUs — main demo
k6 run k6/extreme.js      # 8,000+ VUs — trips the queue
k6 run k6/cold-range.js   # Stampede proof (cold range only)
```

### Autoscaler

```bash
# Run on the host (not in Docker)
python3 scripts/autoscaler.py
```

### Demo Flow (appflow.md Section 7)

| Part | Action |
|---|---|
| 1 | Normal portal: enter roll number, get result |
| 2 | Start k6 ramp — show Grafana traffic climbing |
| 3 | Baseline: `--scale backend=1`, no Redis → errors climb |
| 4 | ResultShield: replicas + cache → latency flat, errors drop |
| 5 | Extreme load → queue activates (202 responses) |
| 5b | Flush cache / use cold range → stampede lock proof |
| 6 | Reduce load → queue drains, replicas scale down, zero drops |

## Key Design Decisions

### Backend has no host port (techspec.md Section 3)
```yaml
backend:
  expose: ["3000"]   # NOT ports: - "3000:3000"
```
This is what allows `--scale backend=N` to work. A host port mapping would cause "port already allocated" at N=2.

### STAMPEDE_MAX_WAIT_MS = 4500 (not 2000)
Must stay below `STAMPEDE_LOCK_TTL_SECONDS × 1000 = 5000ms`. At 2000ms, ordinary slow queries (cold pool, slow disk) would trigger the safety valve and stampede the DB anyway — just delayed by 2 seconds.

### Queue state in Redis (never in process memory)
`queue:waiting` (sorted set) and `capacity:admitted_count` (counter) live in Redis, shared by all replicas. Verify this at `--scale backend=3`, not just 1.

### Graceful shutdown before autoscaler
`shutdown.js` handles `SIGTERM` → flip `/health` to 503 → drain → close. This must exist before the autoscaler is started, because the autoscaler's scale-down sends `SIGTERM`.

### Rate limiting: tokenless requests only
Requests carrying `X-Session-Token` (legitimate queue polls) are never rate-limited. 20 queue polls/minute per queued student would otherwise trigger any reasonable IP-based limit.

## Configuration

All values from `rules.md` Section 10 (the single source of truth):

| Variable | Value | Why |
|---|---|---|
| `CACHE_TTL_SECONDS` | 172800 (48h) | Covers overnight gap between prewarm and judging |
| `STAMPEDE_MAX_WAIT_MS` | 4500 | Below 5s lock TTL with enough margin for slow queries |
| `MAX_CONCURRENT_ADMITTED` | 200 | Queue activates before full-scale system saturates |
| `RATE_LIMIT_UNAUTHENTICATED_RPM` | 20 | New sessions only, not polls |
| `SHUTDOWN_GRACE_MS` | 10000 | 10s to drain in-flight requests |
| `SCALE_UP_THRESHOLD` | 0.70 | Non-overlapping with scale-down |
| `SCALE_DOWN_THRESHOLD` | 0.30 | Non-overlapping with scale-up |

## Data Ranges

| Range | Count | Purpose | Pre-warmed? |
|---|---|---|---|
| 26010001–26059999 | ~50,000 | General pool for all load tests | Yes |
| 26099001–26099100 | 100 | Reserved cold — never pre-warmed, for stampede demo | No |
| 26099999 | 1 | Sentinel — not in DB, reliable not-found | N/A |

## Success Criteria

| Criterion | How to verify |
|---|---|
| SC-01 | `curl localhost/api/result/26010001` returns `{"status":"ok",...}` |
| SC-02 | `k6 run k6/normal.js` completes with no script errors |
| SC-03 | baseline (`backend=1`, no Redis) shows latency/errors climb under heavy.js |
| SC-04 | After flush-cache.sh, `stampede_lock_wait_total` spikes while Postgres rate is flat |
| SC-05 | Compare result-day.js at backend=1 vs backend=4 |
| SC-06 | Autoscaler climbs replicas, Traefik dashboard updates with no manual step |
| SC-07 | Grafana showing live data during any k6 run |
| SC-08 | extreme.js → 202 queued responses; two replicas report same ZRANK for same token |
| SC-09 | Same k6 script used for both baseline and resilient experiments |
| SC-10 | Scale down mid-load-test → zero 5xx correlated with removal timestamps |

## File Structure

```
resultshield/
├── docker-compose.yml          # Full stack — backend has no host port
├── .env.example                # All config from rules.md Section 10
├── frontend/                   # React + Vite SPA
│   ├── src/App.jsx             # 6-screen state machine + queue polling
│   ├── src/index.css           # Design system (design.md Section 11)
│   └── Dockerfile              # Multi-stage: build → nginx static serve
├── backend/                    # Node.js + Express
│   └── src/
│       ├── server.js           # Bootstrap, /health, /metrics
│       ├── routes/result.js    # GET /api/result/:rollNumber
│       └── lib/
│           ├── cache.js        # Cache-aside + stampede lock (4500ms wait)
│           ├── queue.js        # Redis-backed admission queue
│           ├── metrics.js      # prom-client custom metrics
│           └── shutdown.js     # SIGTERM graceful drain
├── db/
│   ├── init.sql                # PostgreSQL schema with full CHECK constraints
│   └── seed/generate-synthetic-results.js
├── monitoring/
│   ├── prometheus.yml          # docker_sd_configs auto-discovery
│   └── grafana/dashboards/     # Pre-built dashboard JSON
├── scripts/
│   ├── autoscaler.py           # Host-side, polls Prometheus, docker compose scale
│   ├── prewarm-cache.js        # Warm general pool (exclude cold range)
│   └── flush-cache.sh          # Demo Part 5b cache flush
├── k6/
│   ├── normal.js               # 100 VUs
│   ├── heavy.js                # 1,000 VUs  
│   ├── result-day.js           # 5,000 VUs (main demo)
│   ├── extreme.js              # 8,000+ VUs (queue demo)
│   └── cold-range.js           # Cold range only (stampede proof)
└── tracker.md                  # Live build checklist (update during build)
```
