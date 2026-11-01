# PayPal sandbox layer: notes

What the PayPal layer does, what PayPal really answered, and what is still an assumption. Everything is PayPal **sandbox** only. The recorded answers behind the rules are in `test/fixtures/paypal/` (31 Oct 2026 disputes spike, e-mail addresses removed).

## Can the seller see the homeowner's transaction id before a claim exists?

No. Checked on 1 Nov 2026 with read-only calls on the spike's case A (capture `9UA851170T503222E`, the homeowner's id `27S431280V029084G`):

| Call | Answer | Homeowner's id in it? |
|---|---|---|
| `GET /v2/payments/captures/{id}` | 200; `supplementary_data.related_ids` holds only `order_id` | no |
| `GET /v2/checkout/orders/{id}` | 200; the `payer` block has the payer id and name, the capture has the seller's id | no |
| `GET /v1/reporting/transactions?transaction_id=…&fields=all` | **403 NOT_AUTHORIZED** ("insufficient permissions"): the Default Application has no Transaction Search access | not reachable; enabling it means changing the shared app, so it was not done |
| `GET /v1/customer/disputes/{id}` (claim exists) | 200; `disputed_transactions[].buyer_transaction_id` | yes |

So the id appears when PayPal lists the claim. Until then `filing.filing_url` is `https://www.sandbox.paypal.com/resolutioncenter`; after that it is `…/resolutioncenter/filing/<id>`. (The reporting API's documented fields name the seller's transaction id, so it is unlikely to help even with access; not verified.)

## How the tracker finds the claim

The homeowner files on PayPal's site, so the app has no claim id. The dispute **list** does not carry `seller_transaction_id` or `custom`: an item holds the dispute id, times, status, amount, `buyer_transaction_id` and the payer and merchant ids (spike raw 035/036). So:

1. `GET /v1/customer/disputes?disputed_transaction_id=<our capture id>&page_size=20`: filtering by the seller's capture id works (raw 036). Sent live on 1 Nov 2026 with exactly this query for capture `9UA851170T503222E`: 200, one item (`PP-R-HAX-10195521`), debug id `f428335ae19ca`, so PayPal accepts `page_size`.
2. Each listed dispute, newest first, is read with `GET /v1/customer/disputes/{id}` and kept only if `disputed_transactions[].seller_transaction_id` is our capture id or `custom` is our `MIR-<case id>`.
3. From then on the dispute is followed by id only. A resolved dispute is not asked about again.

PayPal lists a new claim minutes after it exists (empty at 18:26, listed by 18:34 in the spike), while a read by id works at once. An empty list therefore means "look again", never "no claim". Poll every 60 to 120 seconds (`MIR_POLL_SECONDS`, minimum 30; off by default). The poller leaves out payments past day 180 and resolved claims, and a case that fails three times in a row waits 5, 10, 20, then 30 minutes between tries (a good look clears it; a person asking is never held back). `stop()` waits for a tick in flight, so the database is never closed under it. `GET /api/cases/:id/dispute` answers from memory for 15 seconds per case; an action or any other look the service makes renews it, and a payment change clears it.

## Mapping rules (PayPal answer to our objects)

| Our field | Rule |
|---|---|
| `dispute.original_claim_amount` | the first amount we saw and never changed; PayPal rewrites `dispute_amount` and `offer.buyer_requested_amount` once an offer is accepted (400.00 became 300.00). If our first look already comes after an accepted offer, our own claim amount stands in |
| `dispute.escalated_at` | the date of the evidence PayPal marks `action_info.action = ESCALATE` (the contractor's side escalating, 18:33:55); when the homeowner escalates on the site PayPal leaves no marker, so it is the update time at which we first see stage `CHARGEBACK`. Once set it never moves. Seen first when already resolved: null |
| `offer` | the newest `offer.history` event `PROPOSED` (amount, time); note = the seller message posted at the same time; status from what follows: `ACCEPTED` → accepted, `DENIED`/`DECLINED`/`REJECTED` → declined, `CANCELED`/`CANCELLED` → canceled, nothing → pending. Pending in stage `CHARGEBACK` or in a closed dispute → canceled |
| `outcome` | appears as soon as PayPal moves money: the buyer's `CREDIT` entries in `money_movements` (fees charged to the contractor are not counted); `dispute_outcome` adds `outcome_code` and `outcome_reason` when the dispute is resolved. `status`: `money_back` / `denied` (`RESOLVED_SELLER_FAVOUR`) / `closed` |
| `outcome.refund_destination` | always "the payment method you used": PayPal does not name it in the dispute (the homeowner's activity shows the bank) |

Observed (spike): accepted offer, contractor accepts claim, PayPal decides. **Not observed**: the event names for a declined or canceled offer, and that an open offer is canceled when the case goes to PayPal (PayPal's escalate dialog says so). Those two rules come from PayPal's docs and dialog text, not from an answer.

## The payment: capture states

PayPal can answer a capture with a status other than COMPLETED (PENDING). Whenever PayPal returns a capture, the case stores its id and status (`payment.capture_id`, `payment.capture_status`) and `payment.status` becomes `pending`; only COMPLETED makes it `captured` (then `paid_at`, `captured_at` and `method` are set, and only then does the tracker look for a claim). While pending, `POST .../capture` reads `GET /v2/payments/captures/{id}` instead of capturing again (a second capture would replay the same answer or fail), and answers 409 `PAYMENT_NOT_COMPLETED` until it is COMPLETED. If the order was captured already (an earlier answer got lost), PayPal's 422 `ORDER_ALREADY_CAPTURED` makes the code read the order and take the capture from it. `claim.transaction_id` is the homeowner's own id and stays null until PayPal lists their claim; our capture id is `case.payment.capture_id`.

## "PayPal decides" in the sandbox

After an escalation PayPal opens `adjudicate` only once the contractor has answered the chargeback (spike section 5, B: evidence at 19:00:06Z, `adjudicate` link at 19:28:13Z). The path is: `POST /api/cases/:id/escalate` (or the homeowner escalates on PayPal's site), then `POST /api/sim/contractor/:id/evidence` (`{ "note"? }`), then `POST /api/cases/:id/adjudicate` once PayPal has opened it. `adjudicate` answers 409 `CONTRACTOR_MUST_ANSWER_FIRST` ("The contractor has to answer PayPal first") while the stored claim is in stage CHARGEBACK and status WAITING_FOR_SELLER_RESPONSE, and 409 `ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE` ("PayPal opens this step after a review delay") when PayPal itself refuses.

## Limits

Request bodies on `/api/*` are limited to 256 KB (413 `PAYLOAD_TOO_LARGE`). A case takes at most 50 promised items and 50 verdicts; every free-text field (contractor name, title, quote, reference, note) is at most 500 characters, an item id 64. Amounts have at most 10 digits before the decimal point and two after, a quantity is 1 to 1000, so price times quantity stays an exact integer number of cents. `paid_at` must be a real calendar day (round trip through a date). Finding the case that owns an order or a dispute uses an indexed lookup, not a read of every case; the poller still reads all cases once per tick.

## Errors on the HTTP API

`{ "error": { "code", "message" } }`. 400 bad input · 404 unknown case · 409 not possible yet (`NO_PAYMENT`, `ORDER_NOT_APPROVED`, `PAYMENT_NOT_COMPLETED`, `PAYMENT_PENDING`, `ALREADY_PAID`, `NO_CLAIM_YET`, `CONTRACTOR_MUST_ANSWER_FIRST`, `ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE` with "PayPal opens this step after a review delay") · 413 body over 256 KB · 403 one of our own guards refused the call · 502 PayPal unavailable or refused (its words are in the message) · 500 anything else (no detail).

PayPal's own `adjudicate` answer is 400 `ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE` until it opens the step (about 28 minutes after the contractor's response in the spike).

## Guards (code and tests)

| Guard | Where |
|---|---|
| sandbox base URL only; any other URL throws | `PayPalClient` constructor |
| credentials per instance, token per instance; no environment reads and no module-level state (a test checks the source) | `src/paypal/*` |
| the four hold ids of the other project are refused in path, query and body before any network call | `PayPalClient.request` |
| orders need `custom_id` starting with `MIR-`; POST and PATCH only on orders and disputes recorded on a case in our store; creating disputes and any other mutation is refused | `PayPalClient`, `src/ownership.ts` |
| `/v1/notifications/webhooks*` never called (the app is shared; we poll); repeated slashes count as one, so `/v1//notifications//webhooks` is refused too | `PayPalClient` |
| journal records method, path (no query), status, ms and debug id only; the file is opened at start (a bad path stops the start) and a failing write is logged, never passed to the PayPal call | `PayPalClient`, `src/journal.ts`, `MIR_CALL_JOURNAL` |

## Running

`PAYPAL_SANDBOX_CLIENT_ID` and `PAYPAL_SANDBOX_CLIENT_SECRET` are required (only `src/server.ts` and `scripts/live-check.ts` read the environment). Optional: `PORT` (8787), `MIR_DATA_DIR` (`./data`), `MIR_RETURN_URL` / `MIR_CANCEL_URL` (`http://localhost:<port>/paypal/return|cancel`), `MIR_POLL_SECONDS`, `MIR_CALL_JOURNAL` (a file path). `npm run dev` / `npm run start`.

Live checks, through the wrapper that injects the secrets: `VAULT_EGRESS_OK=api-m.sandbox.paypal.com tools/lbl/with-sandbox-env.sh npx tsx scripts/live-check.ts research | disputes | list | smoke-order`.

## Live checks of 1 Nov 2026

- `research`: see the table above.
- `disputes`: the three spike claims read by id and run through the mapping: A resolved, offer accepted, outcome 300.00, original 400.00; B resolved, escalated at 18:33:55.518Z, outcome 400.00; C resolved, outcome 400.00, escalation time null (first seen after it was resolved).
- `list`: the tracker's own query for capture `9UA851170T503222E` (`disputed_transaction_id` and `page_size=20`) answered 200 with one item, `PP-R-HAX-10195521`.
- `smoke-order`: one order `MIR-B4-SMOKE-1` with three promised items, one of them an uneven split ("Interior doors (3)"), accepted by PayPal (200, `PAYER_ACTION_REQUIRED`), never approved or captured.
