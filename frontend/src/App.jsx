import { useState, useEffect, useRef, useCallback } from 'react'
import './index.css'

// ─── Constants (mirrors rules.md env vars) ────────────────────────────────
const QUEUE_POLL_INTERVAL_MS = parseInt(
  import.meta.env.VITE_QUEUE_POLL_INTERVAL_MS || '5000', 10
)
const QUEUE_POLL_JITTER_MS = parseInt(
  import.meta.env.VITE_QUEUE_POLL_JITTER_MS || '1500', 10
)

const API_BASE = import.meta.env.VITE_API_BASE || '/api'

// ─── State machine states (appflow.md Section 3) ──────────────────────────
const STATE = {
  IDLE:       'IDLE',
  SUBMITTING: 'SUBMITTING',
  FOUND:      'FOUND',
  NOT_FOUND:  'NOT_FOUND',
  QUEUED:     'QUEUED',
  ERROR:      'ERROR',
}

// ─── Roll number validation ────────────────────────────────────────────────
const ROLL_RE = /^[0-9]{8}$/

// ─── Jitter helper ────────────────────────────────────────────────────────
function jitter(base, spread) {
  return base + (Math.random() * spread * 2 - spread)
}

// ─── Session token helpers (appflow.md Section 6) ─────────────────────────
// sessionStorage — dies with the tab, not localStorage
const TOKEN_KEY    = 'rs_session_token'
const ROLL_KEY_SS  = 'rs_queued_roll'

function getStoredToken()  { return sessionStorage.getItem(TOKEN_KEY)   || null }
function getStoredRoll()   { return sessionStorage.getItem(ROLL_KEY_SS) || null }
function storeToken(t, r)  {
  sessionStorage.setItem(TOKEN_KEY, t)
  sessionStorage.setItem(ROLL_KEY_SS, r)
}
function clearToken()      {
  sessionStorage.removeItem(TOKEN_KEY)
  sessionStorage.removeItem(ROLL_KEY_SS)
}

// ─── API call ─────────────────────────────────────────────────────────────
async function fetchResult(rollNumber, sessionToken = null) {
  const headers = { 'Content-Type': 'application/json' }
  if (sessionToken) headers['X-Session-Token'] = sessionToken

  const res = await fetch(`${API_BASE}/result/${rollNumber}`, { headers })
  return { status: res.status, body: await res.json() }
}

// ─── Components ───────────────────────────────────────────────────────────

// Verdict Seal (design.md Section 6)
function VerdictSeal({ verdict }) {
  const isPass = verdict === 'PASS'
  return (
    <div className={`seal ${isPass ? 'seal--pass' : 'seal--fail'}`} role="img" aria-label={`Verdict: ${verdict}`}>
      <span className="seal-label">ResultShield</span>
      <span className="seal-word">{verdict}</span>
      <span className="seal-ring-text">Verified</span>
    </div>
  )
}

// Queue Gauge (design.md Section 7, rules.md Section 9)
// angle = (1 − currentPosition / initialPosition) × 180° 
function QueueGauge({ position, initialPosition }) {
  const safeInitial = initialPosition || position || 1
  const ratio = Math.max(0, Math.min(1, 1 - (position / safeInitial)))
  const angleDeg = ratio * 180  // 0° = fully busy, 180° = fully free

  // SVG semicircle: center=(110,110), r=90, starts at 180° (left), ends at 0° (right)
  const cx = 110, cy = 110, r = 90
  const circumference = Math.PI * r  // half circle
  const dashOffset = circumference * (1 - ratio)

  // Needle: from center point, rotated by angleDeg from left
  const needleLength = 75
  const needleAngleDeg = 180 - angleDeg  // 0 ratio→left(180°), 1 ratio→right(0°)
  const needleRad = (needleAngleDeg * Math.PI) / 180
  const nx = cx + Math.cos(needleRad) * needleLength
  const ny = cy - Math.sin(needleRad) * needleLength  // SVG y is flipped

  // Gradient color: navy→amber→oxblood
  let fillColor = '#1B2A4A'
  if (ratio < 0.5) fillColor = '#C9822B'
  if (ratio < 0.2) fillColor = '#8B2635'

  return (
    <div className="gauge-container" aria-hidden="true">
      <svg className="gauge-svg" viewBox="0 0 220 120">
        <defs>
          <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%"   stopColor="#8B2635" />
            <stop offset="50%"  stopColor="#C9822B" />
            <stop offset="100%" stopColor="#1B2A4A" />
          </linearGradient>
        </defs>

        {/* Background track */}
        <path
          className="gauge-track"
          d={`M 20 110 A 90 90 0 0 1 200 110`}
        />

        {/* Fill arc */}
        <path
          className="gauge-fill"
          d={`M 20 110 A 90 90 0 0 1 200 110`}
          stroke="url(#gaugeGrad)"
          strokeDasharray={`${circumference}`}
          strokeDashoffset={dashOffset}
          style={{ strokeDashoffset: dashOffset }}
        />

        {/* Needle */}
        <line
          className="gauge-needle-line"
          x1={cx} y1={cy}
          x2={nx} y2={ny}
          style={{ transform: `rotate(0deg)` }}
        />
        <circle cx={cx} cy={cy} r="5" fill="var(--color-ink-navy)" />

        {/* Labels */}
        <text x="16" y="130" fontSize="9" fill="#8B2635" fontFamily="var(--font-mono)" opacity="0.6">busy</text>
        <text x="178" y="130" fontSize="9" fill="#1B2A4A" fontFamily="var(--font-mono)" opacity="0.6">calm</text>
      </svg>
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen]           = useState(STATE.IDLE)
  const [rollInput, setRollInput]     = useState('')
  const [inputError, setInputError]   = useState('')
  const [result, setResult]           = useState(null)
  const [queueData, setQueueData]     = useState(null)
  const [sessionToken, setSessionToken] = useState(null)
  const [currentRoll, setCurrentRoll]   = useState(null)
  const [initialQueuePos, setInitialQueuePos] = useState(null)
  // Cosmetic countdown between polls
  const [displayedWait, setDisplayedWait] = useState(null)

  const pollTimerRef     = useRef(null)
  const countdownRef     = useRef(null)
  const isMountedRef     = useRef(true)

  // ── On mount: check sessionStorage for a resumable queued session ──────
  useEffect(() => {
    isMountedRef.current = true
    const storedToken = getStoredToken()
    const storedRoll  = getStoredRoll()
    if (storedToken && storedRoll) {
      setSessionToken(storedToken)
      setCurrentRoll(storedRoll)
      setScreen(STATE.SUBMITTING)
      doFetch(storedRoll, storedToken)
    }

    return () => {
      isMountedRef.current = false
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
      if (countdownRef.current) clearInterval(countdownRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const clearAllTimers = () => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
    if (countdownRef.current) {
      clearInterval(countdownRef.current)
      countdownRef.current = null
    }
  }

  // ── Fetch function (used for initial submit + polling) ────────────────
  const doFetch = useCallback(async (roll, token) => {
    try {
      const { status, body } = await fetchResult(roll, token)
      if (!isMountedRef.current) return

      if (status === 200 && body.status === 'ok') {
        clearToken()
        clearAllTimers()
        setResult(body)
        setScreen(STATE.FOUND)

      } else if (status === 200 && body.status === 'error') {
        clearToken()
        clearAllTimers()
        setScreen(STATE.NOT_FOUND)

      } else if (status === 202) {
        const newToken = body.sessionToken
        storeToken(newToken, roll)
        setSessionToken(newToken)
        setCurrentRoll(roll)
        setQueueData(body)
        setDisplayedWait(body.estimatedWaitSeconds)

        if (screen !== STATE.QUEUED) {
          setInitialQueuePos(body.position)
          setScreen(STATE.QUEUED)
        }

        // Adaptive polling interval based on position (scaled for 100,000+ users)
        let baseInterval = QUEUE_POLL_INTERVAL_MS
        if (body.position <= 50) baseInterval = 2500
        else if (body.position > 500) baseInterval = 8000

        clearAllTimers()
        pollTimerRef.current = setTimeout(() => {
          if (isMountedRef.current) {
            doFetch(roll, newToken)
          }
        }, jitter(baseInterval, QUEUE_POLL_JITTER_MS))

        countdownRef.current = setInterval(() => {
          if (isMountedRef.current) {
            setDisplayedWait((w) => (w !== null && w > 0 ? w - 1 : 0))
          }
        }, 1000)

      } else {
        clearToken()
        clearAllTimers()
        setScreen(STATE.ERROR)
      }
    } catch (_err) {
      if (isMountedRef.current) {
        clearToken()
        clearAllTimers()
        setScreen(STATE.ERROR)
      }
    }
  }, [screen])

  // ── Submit handler ────────────────────────────────────────────────────
  const handleSubmit = useCallback((e) => {
    e.preventDefault()
    const roll = rollInput.trim()

    if (!ROLL_RE.test(roll)) {
      setInputError('Enter exactly 8 digits (e.g. 26010001)')
      return
    }
    setInputError('')
    setScreen(STATE.SUBMITTING)
    setCurrentRoll(roll)
    doFetch(roll, null)
  }, [rollInput, doFetch])

  // ── Navigation helpers ────────────────────────────────────────────────
  const goHome = () => {
    clearToken()
    clearAllTimers()
    setScreen(STATE.IDLE)
    setRollInput('')
    setResult(null)
    setQueueData(null)
    setSessionToken(null)
    setInitialQueuePos(null)
    setDisplayedWait(null)
  }

  const handleRetry = () => {
    if (currentRoll) {
      setScreen(STATE.SUBMITTING)
      doFetch(currentRoll, sessionToken)
    } else {
      goHome()
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────
  return (
    <div className="app-container">
      <div className="card">

        {/* ── HOME ──────────────────────────────────────────────────── */}
        {screen === STATE.IDLE && (
          <>
            <div className="wordmark">ResultShield</div>
            <div className="wordmark-sub">Examination Result Portal</div>

            <form onSubmit={handleSubmit} noValidate>
              <div className="form-group">
                <label htmlFor="roll-number-input">Roll Number</label>
                <input
                  id="roll-number-input"
                  type="text"
                  className="roll-input"
                  value={rollInput}
                  onChange={(e) => {
                    setRollInput(e.target.value)
                    if (inputError) setInputError('')
                  }}
                  placeholder="26010001"
                  maxLength={8}
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck="false"
                  aria-describedby={inputError ? 'roll-error' : undefined}
                  aria-invalid={!!inputError}
                />
                {inputError && (
                  <div id="roll-error" className="input-error" role="alert">
                    {inputError}
                  </div>
                )}
              </div>

              <button
                type="submit"
                className="btn-primary"
                disabled={!rollInput.trim()}
                id="check-result-btn"
              >
                Check Result
              </button>
            </form>
          </>
        )}

        {/* ── CHECKING ──────────────────────────────────────────────── */}
        {screen === STATE.SUBMITTING && (
          <div className="checking-container" role="status" aria-live="polite">
            <div className="spinner" aria-hidden="true" />
            <p className="checking-text">Checking your result…</p>
            {currentRoll && (
              <p className="checking-text" style={{ fontFamily: 'var(--font-mono)', opacity: 0.5 }}>
                {currentRoll}
              </p>
            )}
          </div>
        )}

        {/* ── RESULT FOUND ──────────────────────────────────────────── */}
        {screen === STATE.FOUND && result?.data && (
          <>
            <div className="result-header">
              <VerdictSeal verdict={result.data.resultStatus} />
              <div className="result-meta">
                <h2>Roll Number</h2>
                <p>{result.data.rollNumber}</p>
                <div className="result-name">{result.data.name}</div>
                <div className="result-course">{result.data.course}</div>
                {result.cache && (
                  <span className={`cache-badge cache-badge--${result.cache}`}>
                    {result.cache === 'hit' ? '⚡ Cache hit' : '🔍 DB fetch'}
                  </span>
                )}
              </div>
            </div>

            <hr className="divider" />

            <table className="marks-table" aria-label="Subject marks">
              <thead>
                <tr>
                  <th scope="col">Subject</th>
                  <th scope="col" style={{ textAlign: 'right' }}>Marks</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(result.data.marks).map(([subject, mark]) => (
                  <tr key={subject}>
                    <td>{subject.replace(/([A-Z])/g, ' $1')}</td>
                    <td>{mark} / 100</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <hr className="divider" />

            <div className="summary-row">
              <span className="summary-label">Total</span>
              <span className="summary-value">{result.data.total}</span>
            </div>
            <div className="summary-row">
              <span className="summary-label">Percentage</span>
              <span className="summary-value">{result.data.percentage.toFixed(1)}%</span>
            </div>

            <hr className="divider" style={{ marginTop: 'var(--space-2)' }} />

            <button className="btn-secondary" onClick={goHome} id="check-another-btn">
              Check Another Result
            </button>
          </>
        )}

        {/* ── NOT FOUND ─────────────────────────────────────────────── */}
        {screen === STATE.NOT_FOUND && (
          <div className="not-found-container">
            <div className="not-found-icon" aria-hidden="true">📋</div>
            <h1 className="not-found-title">Roll Number Not Found</h1>
            <p className="not-found-body">
              No record for <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{currentRoll}</span>.
              Please check the number and try again.
            </p>
            <button className="btn-primary" onClick={goHome} id="try-again-btn">
              Try Again
            </button>
          </div>
        )}

        {/* ── QUEUED ────────────────────────────────────────────────── */}
        {screen === STATE.QUEUED && queueData && (
          <>
            <div className="queue-header">
              <div className="queue-badge">High Traffic</div>
              <h1 className="queue-title">You're in the Queue</h1>
              <p className="queue-subtitle">
                Updating automatically — no need to refresh
              </p>
            </div>

            <QueueGauge
              position={queueData.position}
              initialPosition={initialQueuePos}
            />

            <div className="queue-stats">
              <div className="queue-stat">
                <div className="queue-stat-label">Your Position</div>
                <div className="queue-stat-value" aria-live="polite">
                  {queueData.position.toLocaleString()}
                </div>
                <div className="queue-stat-unit">in queue</div>
              </div>
              <div className="queue-stat">
                <div className="queue-stat-label">Est. Wait</div>
                <div className="queue-stat-value" aria-live="polite">
                  {displayedWait !== null ? displayedWait : queueData.estimatedWaitSeconds}
                </div>
                <div className="queue-stat-unit">seconds</div>
              </div>
            </div>

            <div className="queue-pulse" aria-live="polite" aria-atomic="true">
              <span className="pulse-dot" aria-hidden="true" />
              Checking every few seconds
            </div>
          </>
        )}

        {/* ── ERROR ─────────────────────────────────────────────────── */}
        {screen === STATE.ERROR && (
          <div className="error-container">
            <h1 className="error-title">Something Went Wrong</h1>
            <p className="error-body">
              The result couldn't be retrieved. Please try again.
            </p>
            <button className="btn-primary" onClick={handleRetry} id="retry-btn">
              Retry
            </button>
            <button
              className="btn-secondary"
              onClick={goHome}
              style={{ marginTop: 'var(--space-2)' }}
              id="back-home-btn"
            >
              Back to Home
            </button>
          </div>
        )}
      </div>

      <footer className="app-footer">
        ResultShield · Exam Infrastructure Demo · Synthetic data only
      </footer>
    </div>
  )
}
