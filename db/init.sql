-- ResultShield — PostgreSQL init schema
-- Runs automatically on first Postgres start via /docker-entrypoint-initdb.d/

CREATE TABLE IF NOT EXISTS results (
  roll_number  VARCHAR(20)   PRIMARY KEY CHECK (roll_number ~ '^[0-9]{8}$'),
  name         VARCHAR(100)  NOT NULL,
  course       VARCHAR(100)  NOT NULL,
  marks        JSONB         NOT NULL,
  total        INTEGER       NOT NULL CHECK (total >= 0),
  percentage   NUMERIC(5,2)  NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
  status       VARCHAR(10)   NOT NULL CHECK (status IN ('PASS', 'FAIL')),
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- roll_number as PK already provides the only index this system needs
-- No additional indexes — the only query pattern is exact PK lookup

-- Grant permissions for app user
GRANT ALL PRIVILEGES ON TABLE results TO app;
