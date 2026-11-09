# Sandbox evidence: the claim path, end to end

PayPal **sandbox** only: test accounts and test money. Amounts, ids and states are from PayPal's answers; the homeowner's steps were done on PayPal's sandbox site.

## The demo case on the hosted demo, 9 Nov 2026

The demo case from payment to money back, on https://makeitright.retailbox-automation.com (`main` 0f20c86; the homeowner's copy of the demo case is `de35db1b41bc`). Steps marked "through the app" went through the hosted app itself. Every id below was read again from PayPal on 9 Nov 2026 at 22:02 UTC.

| UTC | Step | PayPal's record |
|---|---|---|
| 17:15 | A sandbox buyer approves the $3,700.00 order made of the six promised items; the app captures it | order `7PK2257549221023Y` `COMPLETED`, 6 items, `custom_id` `MIR-de35db1b41bc`; capture `1C115562UL725224L` |
| 18:33 | The homeowner files "Service not received" on PayPal's site for four items, $2,650.00 | claim `PP-R-DVT-10197552`, `MERCHANDISE_OR_SERVICE_NOT_RECEIVED`, $2,650.00, homeowner's id `3YB04350TA902450X` |
| 18:42 | Sandbox stand-in: the contractor offers $1,200 through the app | `offer.history`: `PROPOSED` $1,200.00 at 18:42:11 |
| 18:47 | Escalated through the app | stage `CHARGEBACK` at 18:50 |
| 18:51 | The app asks PayPal to decide (`adjudicate`, sandbox only) | adjudication `RECOVER_FROM_SELLER` at 18:51:09, reason `INELIGIBLE_SELLER_PROTECTION_POLICY` |
| 18:52 | Money moves | homeowner credited $2,650.00; seller debited $2,650.00 plus fees of $129.62 and $15.00 |
| 18:53 | Resolved | `RESOLVED_BUYER_FAVOUR`, refunded $2,650.00; the capture is now `PARTIALLY_REFUNDED` |

The app found the claim in PayPal's list when we pressed "Check PayPal now" on the claim screen at 18:41; whether its background poller would have found it first was not observed in this run (the 3 Nov scenes below show the poller finding claims by itself). The $1,200 offer was never paid: PayPal refunded the full claim. PayPal's offer history has no cancel event for it, so the app shows the offer as canceled by its own rule (`docs/paypal-notes.md`, mapping of `offer`). The finished case is open to anyone at `/cases/de35db1b41bc/money-back`.

## 3 Nov 2026: the claim path through the app's API

A live run of the PayPal layer on 3 Nov 2026, 14:01 to 14:53 UTC. Everything below went through the app's own HTTP API (`main` 25401f6, poller every 60 s) except where a row says otherwise.

## What was proved

| Scene | Claim of | What happened | Money back | PayPal's outcome |
|---|---|---|---|---|
| Contractor's offer, homeowner accepts on PayPal | $460 | offer $300 through the app, Accept on PayPal's site | **$300** | `RESOLVED_BUYER_FAVOUR` / `INQUIRY_OFFER_PARTIAL_REFUND` |
| Contractor accepts the claim | $400 | `accept-claim` through the app | **$400** | `RESOLVED_BUYER_FAVOUR` / `SELLER_ISSUED_REFUND` |
| Offer declined, homeowner escalates, PayPal decides | $1,350 | offer $500, Decline and escalate on PayPal's site, `adjudicate` through the app | **$1,350** | `RESOLVED_BUYER_FAVOUR` / `INELIGIBLE_SELLER_PROTECTION_POLICY`, 12 min 9 s from filing |
| The full demo claim, PayPal decides | $3,150 | `adjudicate` sent directly, not through the app (see limit 1) | **$3,150** | `RESOLVED_BUYER_FAVOUR` / `INELIGIBLE_SELLER_PROTECTION_POLICY` |

In each of the first three scenes the tracker found the homeowner's claim by itself and read the homeowner's own transaction id from it; the app was never told the case id. After an accepted offer PayPal rewrote the claim to $300 and the app kept the original $460. A declined offer shows as `declined` (PayPal's event is `DENIED`). The homeowner's PayPal activity shows the refunds.

PayPal's claim form takes a partial amount on an item with a quantity: "Recessed lights", 6 units, $240.00 of $720.00; total $3,150.00, matching `dispute_amount` in the API.

The sandbox helper `POST /api/cases/:id/escalate` answered 200 and the claim reached `CHARGEBACK`. The route `POST /api/cases/analyze` also ran live once on the demo job: 201 in 25.6 s, six promised items, and PayPal accepted the order made from them. That order was not paid.

## Limits found

1. **A claim of $3,150 skips the contractor's step.** Three claims of $3,150 reached stage `CHARGEBACK` about 3 minutes after filing, with no `make_offer` or `accept_claim`. All seven claims from $400 to $2,690 stayed in `INQUIRY` with every action open. PayPal's documentation says "not received" claims begin in the inquiry stage and names no amount, so this is what we saw, not a documented rule.

   | Claim | Paid | Files | Stage after about 3 minutes |
   |---|---|---|---|
   | $400 | $600 | 2 | `INQUIRY` |
   | $460 | $4,200 | 1 | `INQUIRY` |
   | $460 | $4,200 | 5 | `INQUIRY` |
   | $500 | $600 | 0 | `INQUIRY` |
   | $1,350 | $4,200 | 0 | `INQUIRY` |
   | $1,800 | $4,200 | 0 | `INQUIRY` |
   | $2,690 | $4,200 | 0 | `INQUIRY` |
   | $3,150 | $4,200 | 5 | `CHARGEBACK` (twice) |
   | $3,150 | $4,200 | 0 | `CHARGEBACK` |

   The share of the payment is not the cause ($500 of $600 stayed in inquiry), nor are the files or the length of the note. The limit lies somewhere above $2,690 and at or below $3,150; it was not narrowed further. **The demo keeps every claim at $2,690 or less.**

2. **Such a claim stays out of the dispute list until something updates it.** One $3,150 claim appeared in the list right after `adjudicate`; another, left alone, was still absent 34 minutes after filing, while a read by id worked at once. The tracker finds claims through the list, so it does not see these until then. One case and one control, so the mechanism is not established.

3. **The contractor's balance has to cover the refund.** This run moved $5,200 of refunds and $345.57 of fees out of the test seller's balance, which ended at -$4,150.69 (its balance before the run was not read). `accept-claim` then answered 422 `INSUFFICIENT_FUNDS`; the app now says 409 `CONTRACTOR_INSUFFICIENT_FUNDS`. PayPal listed the payments under the four open `INQUIRY` claims as Held; the two under open `CHARGEBACK` claims showed Completed. PayPal's page warned that the account would be limited if the balance stayed negative. A sandbox top-up was accepted with an estimated arrival of 3 to 5 business days. Six claims of this run were left open: $3,150 twice, $2,690, $1,800, $500 and $460. Read again on 9 Nov 2026 at 22:02 UTC, they are still open (three under review in `CHARGEBACK`, three in `INQUIRY`), as is the 4 Nov claim of $2,650 below; none of them is used by the demo.

4. **Files did not reach the claim when attached by our test script.** The form listed the files, but `evidences[].documents` was null on all ten claims and the case page showed none. In the 31 Oct spike, files attached differently did arrive. Filing by hand was not repeated in this run.

5. **The homeowner sees the sandbox seller's own name** ("Test Store") in PayPal's activity and case pages. The contractor's name reaches only the payment page (`brand_name`).

## Timing in this run

| Step | Time |
|---|---|
| Filing with the test script | about 40 s |
| Claim appears in the list (tracker's query, read every 45 s) | about 3 to 4 min after filing |
| Contractor's actions open | about 3 min 30 s after filing |
| Offer shows to the homeowner | 16 to 20 s, after reloading the page |
| Accept, to money shown in the app | about 10 s; `RESOLVED` about 2 min later |
| Homeowner escalates, to `adjudicate` open | about 2.5 min (about 28 min after the contractor's response in the 31 Oct spike; the cause of the difference is unknown) |
| `adjudicate`, to `RESOLVED` | about 2 min |

## Objects

| Case | Custom id | Capture | Homeowner's id | Claim | Amount | State at the end of the run |
|---|---|---|---|---|---|---|
| A | `MIR-75c7cd737c49` | `7J182904KX0748446` | `4FK40159UY649560C` | `PP-R-TII-10196163` | $3,150.00 | open, `CHARGEBACK` |
| C | `MIR-681802fdba1d` | `84401750VX650170P` | `94V89526NR035722B` | `PP-R-BWL-10196165` | $3,150.00 | resolved, $3,150.00 |
| B | `MIR-f9d6523cb60b` | `37P05026B0912203K` | `3ME69098L3996783W` | `PP-R-SJC-10196168` | $460.00 | resolved, $300.00 |
| T1 | `MIR-a9eb2072c8de` | `1JG49391KG008990T` | `3T535519YR7133452` | `PP-R-BPO-10196169` | $400.00 | resolved, $400.00 |
| T2 | `MIR-a6d1a5d3d330` | `9T4670539K686922K` | `2RV692589S9249420` | `PP-R-VIN-10196171` | $1,350.00 | resolved, $1,350.00 |
| T3 | `MIR-400a413c6e10` | `6L252194WD556193N` | `1NS50862LF803113U` | `PP-R-LGK-10196172` | $1,800.00 | open, `INQUIRY` |
| T4 | `MIR-c9bd5b4a5718` | `0WW65853R31677236` | `64U549884A694863L` | `PP-R-NLF-10196174` | $2,690.00 | open, escalated, `CHARGEBACK` |
| T5 | `MIR-91c60b2cf316` | `6WU85354W34335021` | `20V260353D9785213` | `PP-R-CHO-10196175` | $500.00 | open, offer $200 pending |
| T6 | `MIR-eb54dbe585dc` | `0V4406468N103460W` | `266875001V122963U` | `PP-R-YTB-10196176` | $3,150.00 | open, `CHARGEBACK` |
| T7 | `MIR-c627a599dcce` | `0MD40171NH211140A` | `3NB05118EM680621S` | `PP-R-KIS-10196177` | $460.00 | open, `INQUIRY` |

## Not proved yet

- An open offer canceled by escalation, in PayPal's own events. On 9 Nov (hosted demo, above) an open $1,200 offer was followed by escalation and PayPal's decision: the offer was never paid and the full claim was refunded, but PayPal's offer history still shows only `PROPOSED`.
- The contractor's evidence route, `POST /api/sim/contractor/:id/evidence`, in this run.

## After this run

- **The demo claim is now $2,650.00** (paid $3,700.00, main panel $1,300.00), below the limit found above. On 4 Nov a claim of exactly $2,650.00 stayed in `INQUIRY` with the contractor's actions open, and the tracker found it by itself (`PP-R-NFZ-10196419`).
- **The photo check reaches the demo claim:** with new demo photos (each one shows one promised item) it gives a claim of 2650.00 in 5 runs out of 5 (`demo/ridgeway/PROVENANCE.md`). The run above, on the old photos, answered $1,025.00.
