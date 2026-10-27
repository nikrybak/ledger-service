# ledger-service

A double-entry ledger HTTP API in TypeScript. Accounts hold a single currency, transfers are posted as
balanced journal entries, and balances are always derived from those entries. Transfers are idempotent
and safe under concurrency.

Stack: Node.js 22+, TypeScript (strict), Fastify 5, zod, PostgreSQL via `pg`, Vitest.

## Design decisions

**Hexagonal layout.** `src/domain` is pure logic with no I/O. `src/application` holds the use cases and the
ports they need (`LedgerRepository`, `Clock`, `IdGenerator`). `src/infrastructure` holds the adapters: Fastify
HTTP, an in-memory repository and a PostgreSQL repository. `src/compositionRoot.ts` is the only place that
knows concrete classes; everything is wired through constructors.

**Money.** Amounts are `bigint` minor units end to end (cents for USD). The API accepts and returns
amounts as digit strings, because JSON numbers lose precision above 2^53. FX rates are decimal strings
parsed into an exact `numerator / 10^scale` value; conversion rounds half up to the nearest minor unit.
Floats never touch money.

**Derived balances.** There is no mutable `balance` column. A balance is
`sum(credits) - sum(debits)` over an account's postings. A stored counter can drift from history after a
bug, a partial write or a manual fix; a derived balance cannot, and the history is the audit trail. The
`postings (account_id, seq DESC) INCLUDE (direction, amount)` index makes the sum an index-only scan.
For very hot accounts the next step would be periodic balance snapshots (still derived: snapshot plus
postings after it), not a counter.

**Double entry.** Each transfer is a journal entry whose debits equal its credits per currency; the
domain rejects anything else. Cross-currency transfers are rejected unless the request carries an
explicit `fxRate`. With a rate, the entry has four lines that go through internal per-currency FX clearing
accounts (`debit source USD / credit FX-USD / debit FX-EUR / credit destination EUR`), so each currency
still balances on its own. Ledger tables are append-only (enforced by triggers); corrections are new
transfers.

**Idempotency.** `POST /transfers` requires an `Idempotency-Key` header. Inside the transfer transaction
the service inserts `(key, sha256(canonical payload), transfer_id)` into `idempotency_keys` with
`ON CONFLICT DO NOTHING`:

- No conflict: the key is claimed and the transfer proceeds in the same transaction.
- Conflict with the same hash: the stored transfer is returned with `201` and `Idempotent-Replayed: true`.
- Conflict with a different hash: `409 IDEMPOTENCY_KEY_CONFLICT`.

A concurrent request with the same key blocks on the unique index until the first transaction commits or
rolls back, so a key is never applied twice. Because the claim is part of the transaction, a request that
fails (for example with insufficient funds) does not consume its key and can be retried.

**Locking.** Each transfer runs in one `READ COMMITTED` transaction that locks the source and destination
rows with `SELECT ... FROM accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE`. Locking in id order means
two transfers between the same pair of accounts in opposite directions cannot deadlock. The source
balance is read after the lock is taken; under `READ COMMITTED` that statement gets a fresh snapshot and
sees postings from the transaction it waited for. `REPEATABLE READ` would be wrong here: its snapshot
predates the lock and could show a stale balance.

**Errors and validation.** zod validates every request at the HTTP edge. Domain and application code throw
a typed `DomainError` with a code; `src/infrastructure/http/errorHandler.ts` is the single mapping from
codes to HTTP statuses, typed as a `Record` so a new code cannot be left unmapped. Error bodies have the
form `{ "error": { "code", "message", "details?" } }`.

**Operations.** Structured JSON logs come from pino through Fastify, with a request id taken from
`x-request-id` or generated and echoed back. On `SIGINT`/`SIGTERM` the server stops accepting
connections, drains in-flight requests, closes the PostgreSQL pool, and exits; a timeout
(`SHUTDOWN_TIMEOUT_MS`) forces an exit if draining hangs.

### Known simplifications

- No authentication. Idempotency keys are global; in production they would be scoped per client.
- FX rates apply to minor units directly, so currencies with different exponents (USD and JPY, for
  example) need the rate quoted accordingly.
- The in-memory adapter serialises all transactions with a single mutex. That is correct, but it is not a
  performance model.

## Running

```bash
npm install
cp .env.example .env   # optional; the defaults run with in-memory storage
npm run dev            # http://localhost:3000, pretty logs, in-memory storage
```

With PostgreSQL:

```bash
docker compose up --build   # postgres, then migrations, then the API on :3000
```

Or against an existing database:

```bash
export STORAGE=postgres DATABASE_URL=postgres://ledger:ledger@localhost:5432/ledger
npm run build && npm run migrate && npm start
```

| Variable              | Default        | Notes                            |
| --------------------- | -------------- | -------------------------------- |
| `PORT` / `HOST`       | 3000 / 0.0.0.0 |                                  |
| `LOG_LEVEL`           | `info`         | pino level                       |
| `STORAGE`             | `memory`       | `memory` or `postgres`           |
| `DATABASE_URL`        |                | required when `STORAGE=postgres` |
| `DATABASE_POOL_SIZE`  | `10`           |                                  |
| `SHUTDOWN_TIMEOUT_MS` | `10000`        |                                  |

## Testing

```bash
npm test             # unit, use-case and HTTP tests; no database needed
npm run lint         # ESLint (type-aware) and Prettier
npm run typecheck
```

- `test/domain`: balancing rules, currency and FX rules, insufficient funds.
- `test/application`: use cases against the in-memory adapter, including idempotency and concurrent
  overdraft attempts.
- `test/http`: the full API through `fastify.inject`.
- `test/infrastructure`: the PostgreSQL adapter's transaction and locking protocol against a fake pool,
  plus an opt-in integration suite against a real database:

```bash
docker compose up -d postgres
TEST_DATABASE_URL=postgres://ledger:ledger@localhost:5432/ledger npx vitest run test/infrastructure
```

The integration suite creates a throwaway schema, runs the migrations, and checks concurrent transfers,
same-key races and cross-currency round trips. CI runs it against a PostgreSQL service container.

## API

```bash
# Create a funding account that may go negative, and two customer accounts
FUNDING=$(curl -s localhost:3000/accounts -H 'content-type: application/json' \
  -d '{"name":"Funding","currency":"USD","allowNegativeBalance":true}' | jq -r .id)
ALICE=$(curl -s localhost:3000/accounts -H 'content-type: application/json' \
  -d '{"name":"Alice","currency":"USD"}' | jq -r .id)
EURO=$(curl -s localhost:3000/accounts -H 'content-type: application/json' \
  -d '{"name":"Alice EUR","currency":"EUR"}' | jq -r .id)

# Fund Alice with 100.00 USD
curl -s localhost:3000/transfers -H 'content-type: application/json' \
  -H 'Idempotency-Key: 5f0c1c8e-funding-1' \
  -d "{\"sourceAccountId\":\"$FUNDING\",\"destinationAccountId\":\"$ALICE\",\"amount\":\"10000\"}"

# Convert 25.00 USD to EUR at an explicit rate
curl -s localhost:3000/transfers -H 'content-type: application/json' \
  -H 'Idempotency-Key: 5f0c1c8e-fx-1' \
  -d "{\"sourceAccountId\":\"$ALICE\",\"destinationAccountId\":\"$EURO\",\"amount\":\"2500\",\"fxRate\":\"0.92\"}"

curl -s localhost:3000/accounts/$ALICE                    # balance "7500"
curl -s "localhost:3000/accounts/$ALICE/entries?limit=20" # newest first, with nextCursor
curl -s "localhost:3000/accounts/$ALICE/entries?limit=20&cursor=<nextCursor>"
curl -s localhost:3000/health
```

| Method | Path                    | Success | Typical errors                                                 |
| ------ | ----------------------- | ------- | -------------------------------------------------------------- |
| POST   | `/accounts`             | 201     | 400 validation                                                 |
| GET    | `/accounts/:id`         | 200     | 404 `ACCOUNT_NOT_FOUND`                                        |
| GET    | `/accounts/:id/entries` | 200     | 400 `INVALID_CURSOR`, 404                                      |
| POST   | `/transfers`            | 201     | 400 missing key, 404, 409 key reuse, 422 funds/currency/amount |
| GET    | `/health`               | 200     | 503 when the database is unreachable                           |

A transfer response:

```json
{
  "id": "9d69c073-3a65-4151-8e0d-bd3ab06d0be7",
  "sourceAccountId": "e1ea0e28-...",
  "destinationAccountId": "ecb4d7ae-...",
  "amount": "2500",
  "currency": "USD",
  "destinationAmount": "2300",
  "destinationCurrency": "EUR",
  "fxRate": "0.92",
  "description": null,
  "entries": [
    { "accountId": "e1ea0e28-...", "direction": "debit", "amount": "2500", "currency": "USD" },
    { "accountId": "<fx-usd>", "direction": "credit", "amount": "2500", "currency": "USD" },
    { "accountId": "<fx-eur>", "direction": "debit", "amount": "2300", "currency": "EUR" },
    { "accountId": "ecb4d7ae-...", "direction": "credit", "amount": "2300", "currency": "EUR" }
  ],
  "createdAt": "2026-10-27T07:32:27.846Z"
}
```

## License

[MIT](LICENSE)
