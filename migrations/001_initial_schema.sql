CREATE TABLE accounts (
  id                     uuid PRIMARY KEY,
  name                   text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  currency               char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  allow_negative_balance boolean NOT NULL DEFAULT false,
  system_role            text CHECK (system_role IN ('fx_clearing')),
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- Exactly one FX clearing account per currency; also the conflict target for lazy creation.
CREATE UNIQUE INDEX accounts_fx_clearing_currency_key
  ON accounts (currency)
  WHERE system_role = 'fx_clearing';

CREATE TABLE transfers (
  id                     uuid PRIMARY KEY,
  source_account_id      uuid NOT NULL REFERENCES accounts (id),
  destination_account_id uuid NOT NULL REFERENCES accounts (id),
  amount                 bigint NOT NULL CHECK (amount > 0),
  currency               char(3) NOT NULL,
  destination_amount     bigint NOT NULL CHECK (destination_amount > 0),
  destination_currency   char(3) NOT NULL,
  fx_rate                numeric(24, 12) CHECK (fx_rate > 0),
  description            text,
  created_at             timestamptz NOT NULL,
  CHECK (source_account_id <> destination_account_id),
  CHECK ((currency = destination_currency) = (fx_rate IS NULL))
);

CREATE TABLE postings (
  seq         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id uuid NOT NULL REFERENCES transfers (id),
  line_no     smallint NOT NULL,
  account_id  uuid NOT NULL REFERENCES accounts (id),
  direction   text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount      bigint NOT NULL CHECK (amount > 0),
  currency    char(3) NOT NULL,
  created_at  timestamptz NOT NULL,
  UNIQUE (transfer_id, line_no)
);

-- Serves both cursor pagination and balance aggregation (index-only scan thanks to INCLUDE).
CREATE INDEX postings_account_seq_idx
  ON postings (account_id, seq DESC)
  INCLUDE (direction, amount);

CREATE TABLE idempotency_keys (
  key          text PRIMARY KEY,
  request_hash char(64) NOT NULL,
  -- Deferred because the key is claimed before the transfer row exists in the same transaction.
  transfer_id  uuid NOT NULL REFERENCES transfers (id) DEFERRABLE INITIALLY DEFERRED,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- The ledger is append-only: corrections are new compensating transfers, never edits.
CREATE FUNCTION reject_ledger_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER transfers_append_only
  BEFORE UPDATE OR DELETE ON transfers
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE TRIGGER postings_append_only
  BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
