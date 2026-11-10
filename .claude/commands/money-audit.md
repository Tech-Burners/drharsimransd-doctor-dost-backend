---
description: Audit financial logic in a module against DoctorDost's money rules. Reports findings, changes nothing.
---

# Money audit

Audit the financial logic in: **$ARGUMENTS**

If no module was named, audit every path that touches money: the wallet, calls and
billing, earnings, withdrawals, payments and refunds.

**This command is read-only. Do not edit application code, models, services, routes or
tests. Report findings and propose fixes. The person decides what to apply.**

Read `CLAUDE.md` first. The hard rules, the billing table and the transactions table are
the standard you are auditing against. Any finding that contradicts a confirmed decision
in that file is your error, not the code's.

---

## 1. Wallet balance consistency

- Does any service read `Wallet.balancePaise` to make a decision, rather than only to
  display? Rule 2 says the ledger is authoritative and the cache is never a decision input.
  This is the single most important check in the audit
- Is `getBalance()` reading the newest `WalletLedger` entry's `balanceAfterPaise`, sorted
  and index-served?
- Is the cache written in the same session as every ledger append, with no path that writes
  one without the other?
- Is there any `$inc` on a balance anywhere?

## 2. Ledger and transaction integrity

- Is `WalletLedger` genuinely append-only? Look for any update or delete against it,
  including a soft-delete plugin applied by mistake
- Does every append compute `balanceAfterPaise` inside the session rather than from a value
  read before it opened?
- Is a debit that would take the balance below zero rejected?
- Are refunds appended as new positive entries rather than reversing the original debit?
- Does every one of the five operations in the `CLAUDE.md` transactions table actually open
  a session, use `writeConcern: { w: 'majority' }` and `readConcern: 'snapshot'`, and retry
  on `TransientTransactionError`?
- Is there any money write outside a session?

## 3. Duplicate payments and idempotency

- Does `WalletLedger.idempotencyKey` have a unique index, and does the webhook handler treat
  a duplicate key error as success rather than as an error?
- Is there an application-level `if (await exists(key)) return` guard being relied on instead
  of the unique index? That loses the race between two concurrent deliveries
- Do internal entries use deterministic keys, such as `call:<id>:charge`?
- Do all four money-creating POSTs require `Idempotency-Key` and go through the middleware:
  `/wallet/orders`, `/calls`, `/doctor/withdrawals`, `/calls/:id/prescription`?
- Does the middleware return 409 when the same key arrives with a different body hash,
  rather than silently replaying the old response?

## 4. Razorpay verification

- Is the HMAC verified against the **raw** body, before any JSON parsing or re-serialising?
- Is the webhook route mounted before the body parser, or is a raw body capture in place?
- Is an unverified payload dropped and logged, never credited?
- Is the webhook the **only** path that creates a credit? Check that no controller, success
  callback or client-facing route can write one
- Does the amount on an order come from a server-side allow-list rather than the request
  body?
- Is `PaymentOrder.ledgerEntryId` set in the same transaction as the credit, so
  reconciliation can find money taken but not credited?

## 5. Refunds

- Automatic refunds: does the 2-hour expiry job refund the **full call charge** and mark the
  earning `forfeited`, atomically?
- Can a refund exceed the original `grossPaise` on the call?
- Can the same call be refunded twice, by the job and an admin, or by the job running twice?
- Is the expiry job idempotent on the call id, and does it re-read state and exit if the
  prescription arrived?
- Manual refunds: is a reason and note recorded, and does the amount default to the charge
  rather than being free text with no ceiling?

## 6. Consultation billing and duration

- Does duration come **only** from the derived Agora value, never from the client's end
  message or a client timer?
- Is `deriveCallDuration()` one pure, tested function, and does it return null rather than a
  guess when the events are incomplete?
- Is the rate read from the **snapshot on the call**, never live from the doctor document?
  A doctor changing their rate mid-call must not change that call's price
- Is `commissionPercentSnapshot` on the call and used for the split?
- Is the day or night window resolved once at call start, and never recalculated at end?
- Does the window comparison go through `src/shared/time.ts`? Grep for raw `Date` hour
  arithmetic
- Is `maxAffordableSeconds` computed as `Math.floor(balance / rate) * 60`, landing on a
  minute boundary? Anything else lets round-up billing charge a minute the balance does not
  cover
- Is there exactly one `resolveBilling()`, used by the patient charge, the doctor earning,
  refunds and every admin view? List any second implementation

Verify against the confirmed rules, which are not open to interpretation:

| Duration | Allowance | Expected |
|---|---|---|
| Under 60s | available | 0, allowance consumed |
| Under 60s | consumed | 1 minute |
| Exactly 60s | either | 1 minute, allowance untouched |
| 61s | either | 2 minutes |

- Is the free short call claimed by **inserting** into `ShortCallAllowance` inside the
  session, relying on the unique index, rather than by reading first?
- Is the insert in the call-end session, so an aborted transaction releases it?
- Does a zero-charge call write no ledger entry, no earning row, set
  `prescriptionStatus = 'not_required'`, queue no jobs, and set `isFreeShortCall = true`?
- Is `isFreeShortCall` an explicit field rather than derived from `grossPaise === 0`? A short
  call billed one minute also has a duration under 60 seconds

## 7. Doctor earnings and commission

- Is the earning written with status `held` and released only on prescription submission?
- Does `commissionPercent` fall back to `PlatformSetting.commissionPct` when null? A default
  of 0 means the platform keeps nothing
- Is `netPaise` equal to `grossPaise - commissionPaise` in every path?
- Are retainer doctors excluded from earnings rows entirely, with the full amount retained?
- Is `ended_low_balance` treated exactly like `completed` for earnings and prescriptions?
- Is `NO_END_EVENT` still writing no money, and still marked as pending client confirmation
  rather than promoted to a billing rule?

## 8. Withdrawals

- Is the withdrawable sum recomputed **server-side**, never taken from the request?
- Is it `status = released AND withdrawalRequestId = null`?
- Does the claim update filter on `{ withdrawalRequestId: null }` inside the transaction, and
  abort when the matched count is short? Without that filter two concurrent requests both
  succeed
- Is the minimum checked against `PlatformSetting.minWithdrawalPaise`, not a constant?
- Are retainer doctors refused?
- Is the destination snapshotted at request time, so a doctor editing their bank details
  cannot redirect an approved request?
- Does rejection clear the claim from the earnings rows, returning them to withdrawable?
- Does the index `{ doctorId, status, withdrawalRequestId }` actually serve the sum query?

## 9. Race conditions

For each, say whether the protection is a database constraint or application code. Application
code alone is not protection under concurrency.

- Two Razorpay webhook deliveries for one payment
- Two withdrawal requests against one balance
- Two call-end handlers for one call
- Two short calls for the same patient and doctor pair ending together
- A top-up landing while a call charge is being written
- A prescription submitted at the same moment the expiry job runs
- A second patient calling a busy doctor
- The same scheduled job running in two worker processes

## 10. Integer paise and rounding

- Is every money field an integer? Look for any float, any division producing one, and any
  `parseFloat`
- Is rounding done once, in `billedMinutes()`, and nowhere else? Grep for `Math.round`,
  `Math.ceil`, `Math.floor` and `toFixed` in financial paths
- Does the commission calculation round consistently, and does `gross - commission = net`
  hold exactly after rounding? A split that loses a paise per call loses real money
- Are rupees ever stored, or only formatted at the response edge?
- Is `Number.isSafeInteger` validation present on every money field?

---

## Output

Report as a table, ordered by severity:

| Severity | Location | Finding | Why it matters | Suggested fix |
|---|---|---|---|---|

- **Critical** — money can be lost, duplicated or miscalculated
- **High** — a confirmed business rule is not implemented as agreed
- **Medium** — correct today but fragile under concurrency, retry or a rate change
- **Low** — maintainability

For each critical finding, give the concrete sequence that triggers it: the requests, their
order, and the resulting state. "This could race" is not a finding; "two webhooks 40ms apart
produce two ledger rows" is.

End with: checks that passed, checks you could not complete and why, and anything that looked
wrong but turned out to be correct under a rule in `CLAUDE.md`.

Change nothing.
