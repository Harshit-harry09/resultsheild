# Build Tracker — ResultShield
# Updated by Antigravity during build — checkboxes reflect actual completion

## 0. Related documents

This is the only document meant to be open on a second monitor during the actual build. Everything in it points back to `PRD.md`, `techspec.md`, `appflow.md`, `design.md`, or `schema.md` for detail — this file is just the checklist and the risk list.

---

## 1. One more correction, found while writing this tracker

Walking through `techspec.md` Section 13's setup sequence step by step for this checklist surfaced a missing step: it goes straight from "Postgres and Redis are healthy" to running `scripts/prewarm-cache.js`, without ever calling the seed generator (`db/seed/generate-synthetic-results.js`, defined in `schema.md` Section 2.3) that actually populates Postgres in the first place. Followed literally, the prewarm script would run against an empty database.

**Corrected sequence** (Section 4, Hour 1–4 below reflects this):

```bash
docker compose up -d --build postgres redis pgbouncer prometheus grafana cadvisor traefik
# wait until postgres and redis report healthy
node db/seed/generate-synthetic-results.js   # ← was missing from techspec.md Section 13
node scripts/prewarm-cache.js
docker compose up -d --build backend frontend
docker compose up -d --scale backend=3
```

`techspec.md` Section 13 should be updated to include the seed step.

---

## 2. How to use this

Check items off as they're actually done, not as they're started — a half-finished box hides more than an empty one. If someone hits a problem not already listed in Section 7, add it there immediately, don't just fix it and move on; the next person to touch that part of the system needs to know it existed.

---

## 3. Team role suggestions

Flexible slots, not fixed headcount — split or merge based on actual team size:

- **Backend/API** — `backend/` service, cache logic, queue logic, graceful shutdown (`techspec.md` Section 6)
- **Infra/DevOps** — Docker Compose, Traefik, Prometheus, Grafana wiring (`techspec.md` Sections 7–10)
- **Frontend/Design** — React screens, applying `design.md`'s tokens and components
- **Data/Load-testing** — seed generator, k6 profiles, running the experiments, owning the demo script rehearsal

Whoever ends up idle first should pick up demo rehearsal early rather than waiting for Hour 23 — Section 8 of `appflow.md` needs a full run-through more than once to go smoothly.

---

## 4. Hour-by-hour checklist

### Hour 0–1 — Setup
- [x] Repo scaffolded to match `techspec.md` Section 2's directory structure
- [x] Docker, Node, k6 installed and verified on the build machine
- [ ] Whole team has skimmed all five docs at least once — nobody should be discovering the queue design or the color tokens for the first time at Hour 15
- [ ] Roles assigned (Section 3)

### Hour 1–4 — Core application
- [x] Postgres schema applied from `schema.md` Section 2.1 (`db/init.sql`)
- [x] `db/seed/generate-synthetic-results.js` written and run — **50,000 records seeded, plus the reserved cold/sentinel ranges from `schema.md` Section 3.2**
- [x] Backend `GET /api/result/:rollNumber` working against Postgres directly (no cache yet)
- [x] Backend `GET /health` returns 200
- [x] Frontend Home screen (`appflow.md` Section 4.1) posts to the API and renders Result found / Not found

### Hour 4–5 — Containerization
- [x] Dockerfiles for frontend and backend
- [x] `docker-compose.yml` matches `techspec.md` Section 7
- [x] **Verify: `backend` has no host port mapping** — try `docker compose up -d --scale backend=3` right now, before building anything else on top, and confirm it actually scales

### Hour 5–7 — Traefik
- [x] Traefik routing `/` to frontend, `/api` to backend
- [x] Health-check labels in place; kill one backend replica manually and confirm Traefik stops routing to it within one check interval

### Hour 7–9 — Caching
- [x] `lib/cache.js` implemented per `schema.md` Section 1.1's corrected timing (`STAMPEDE_LOCK_TTL_SECONDS=5`, `STAMPEDE_MAX_WAIT_MS=4500`)
- [x] `scripts/prewarm-cache.js` written and run **after** the seed step (Section 1 above)
- [x] Manual test: flush one key, fire 20 concurrent requests for it, confirm only one Postgres query happens (log line or query count) **(Replaced with automated tests in `cache.test.js`)**

### Hour 9–11 — Queue
- [x] `lib/queue.js` implemented per `techspec.md` Section 6.2 — state in Redis, not in-memory
- [x] Frontend Queued screen + polling with jitter (`appflow.md` Section 6)
- [x] Manual test: force `MAX_CONCURRENT_ADMITTED` low, confirm two different backend replicas report the same queue position for the same session token **(Replaced with automated tests in `queue.test.js`)**

### Hour 11–13 — Monitoring
- [x] Prometheus `docker_sd_configs` picking up backend replicas automatically
- [x] Grafana dashboard built with the panels in `techspec.md` Section 10.2, using the color mapping in `design.md` Section 10
- [x] cAdvisor wired in (or explicitly cut — see Section 5)

### Hour 13–15 — Load testing
- [x] `k6/normal.js`, `k6/heavy.js`, `k6/result-day.js`, `k6/extreme.js` written per `techspec.md` Section 11
- [x] Run each once, confirm they complete without k6 script errors (not yet judging results)

### Hour 15–17 — Autoscaler
- [x] `scripts/autoscaler.py` polling Prometheus and running `docker compose up -d --scale backend=N`
- [x] Confirm thresholds match exactly: `>70% scale up`, `<30% scale down`, no overlap

### Hour 17–18 — Graceful shutdown
- [x] `SIGTERM` handling per `techspec.md` Section 6.3
- [x] Scale down manually mid-load-test, confirm zero dropped requests correlate with the removal

### Hour 18–19 — CI/CD
- [x] GitHub Actions pipeline per `techspec.md` Section 17

### Hour 19–21 — Design pass
- [x] `design.md` tokens applied (Section 11's CSS block dropped into the frontend)
- [x] Verdict seal built (static ring is fine — circular text is explicitly optional, `design.md` Section 6)
- [x] Queue gauge built, needle driven by real position data
- [x] `prefers-reduced-motion` respected on both animated elements

### Hour 21–23 — Full experiment run
- [x] Experiments A–F run in order (`techspec.md` Section 12), real numbers recorded — **this is where `MAX_REPLICAS` and the autoscaler's target-per-replica value get set from measurement, not left at the placeholder defaults in `techspec.md` Section 12**
- [x] Before/after table (`PRD.md` Section 16) filled in with actual measured numbers, not the illustrative ones from `PRD.md` Section 3

### Hour 23–24 — Demo rehearsal
- [ ] Full run-through of `appflow.md` Section 7's table, at least twice
- [ ] Section 7 (risk watchlist) below checked item by item
- [ ] Decide, explicitly, which stampede-proof method to use for Demo Part 5b — full flush (`flush-cache.sh`) or the reserved always-cold roll-number range (`schema.md` Section 3.2) — and rehearse that specific choice, not both

---

## 5. MVP cutline

If behind schedule, cut in this order — each one degrades the demo the least relative to the hours it saves:

1. **CI/CD pipeline** — nice for the repo, invisible in the live demo
2. **Full autoscaler automation** — fall back to running `docker compose up -d --scale backend=N` manually, on camera, narrated as "here's the scale-up happening" instead of automatic; the resilience story survives, it's just hand-triggered
3. **cAdvisor / per-container CPU panels** — keep the app-level metrics (request rate, latency, queue depth, cache hit rate), drop the infra-level ones
4. **Verdict seal circular ring text and press animation** — static badge, correct colors, no motion; the seal still reads as intentional
5. **PgBouncer** — connect the backend directly to Postgres; the connection-exhaustion story is weaker but the cache/queue/scaling story — the actual point of the project — is untouched

Never cut: the stampede-lock proof (Demo Part 5b) or the Redis-backed queue consistency check. Those are the two moments that separate this from "yet another load-balanced app" in a judge's eyes.

---

## 6. Definition of done

Combines `PRD.md` Section 14 and `techspec.md` Section 14 into one list — check every row before calling the build finished.

- [x] SC-01 — synthetic result retrievable
- [x] SC-02 — k6 generates controlled traffic
- [x] SC-03 — baseline shows measurable degradation under load
- [x] SC-04 — Redis measurably reduces DB traffic, **including under the cold-start experiment**, not just when pre-warmed
- [x] SC-05 — multiple replicas measurably improve capacity/latency
- [x] SC-06 — autoscaler scales replicas, and Traefik/Prometheus pick them up with zero manual reconfiguration
- [x] SC-07 — Grafana visibly live during a run
- [x] SC-08 — queue activates past capacity, with **consistent position across replicas**
- [x] SC-09 — same load profile used for baseline and resilient comparisons
- [x] SC-10 — scale-down drops zero in-flight requests

---

## 7. Risk watchlist

Every caveat, accepted limitation, and "verify before assuming" flagged across the other five documents, in one place, checked immediately before the demo starts.

- [ ] **Redis has no persistence** (`schema.md` Section 6) — don't restart the Redis container between demo parts except at the scripted Part 5b moment
- [ ] **Cache TTL is 48h** (`schema.md` Section 1.2) — if more than 48h has passed since `prewarm-cache.js` last ran, re-run it before going on stage
- [ ] **`MAX_REPLICAS` and autoscaler target values are measured, not default** (`techspec.md` Section 15) — confirm Hour 21–23's real numbers are what's actually deployed, not the placeholder table values
- [ ] **Health-check interval creates a brief detection delay** (`techspec.md` Section 15) — expect, and don't panic about, an occasional request landing on a draining replica
- [ ] **Prometheus/Traefik Docker service-discovery label names are version-sensitive** (`techspec.md` Sections 8, 15) — confirmed working against the actual pinned versions in use, not assumed from the spec. Verified with Traefik v3.1 and Prometheus v2.54.0.
- [ ] **Multiple tabs = multiple queue positions** (`appflow.md` Section 6) — don't demo by refreshing in a second tab expecting the same position
- [ ] **Stampede-proof method decided and rehearsed** (Section 4, Hour 23–24 above) — full flush vs. reserved cold range, pick one. `k6/cold-range.js` targets only 26099001–26099100.
- [ ] **Illustrative traffic figures never get quoted as achieved numbers** — the pitch uses whatever was actually measured in Hour 21–23, never `PRD.md` Section 3's 50,000+ figure, which describes national-scale reality, not this laptop
- [ ] **The red verdict-seal color on FAIL** (`design.md` Section 2) — if there's any time left, get one honest reaction from someone outside the team before locking it in
- [x] **RISK ADDED: `techspec.md` docker-compose had STAMPEDE_MAX_WAIT_MS=2000** — corrected to 4500ms throughout. This bug would have allowed stampede bypass on slow-but-not-crashed lock holders.
- [x] **RISK ADDED: `techspec.md` Section 13 setup sequence missing seed step** — corrected. Seed must run before prewarm.
- [x] **RISK ADDED: Cache TTL hardcoded in pseudocode** — corrected to use CACHE_TTL_SECONDS=172800 environment variable.

---

## 8. Pre-demo checklist (last 15 minutes)

- [ ] Cache pre-warmed within the last 48h
- [ ] All containers running, `docker compose ps` shows expected replica count
- [ ] Grafana dashboard open and showing live data on the second screen
- [ ] Known-good roll number and the sentinel not-found roll number (`schema.md` Section 3.2) written down where the presenter can see them
- [ ] `flush-cache.sh` (or the reserved-range k6 profile, per whichever was chosen) ready to run on cue, not being typed live
- [ ] Laptop plugged in, not on battery — six containers plus k6 plus a browser is not a light load
