# Sandbox evidence: the claim path, end to end

A live run of the PayPal layer on 3 Nov 2026, 14:01 to 14:53 UTC. PayPal **sandbox** only: test accounts and test money. Everything below went through the app's own HTTP API (`main` 25401f6, poller every 60 s) except where a row says otherwise; the homeowner's steps were done on PayPal's sandbox site. Amounts, ids and states are from PayPal's answers.

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

3. **The contractor's balance has to cover the refund.** This run moved $5,200 of refunds and $345.57 of fees out of the test seller's balance, which ended at -$4,150.69 (its balance before the run was not read). `accept-claim` then answered 422 `INSUFFICIENT_FUNDS`; the app now says 409 `CONTRACTOR_INSUFFICIENT_FUNDS`. PayPal listed the payments under the four open `INQUIRY` claims as Held; the two under open `CHARGEBACK` claims showed Completed. PayPal's page warned that the account would be limited if the balance stayed negative. A sandbox top-up was accepted with an estimated arrival of 3 to 5 business days. **Six claims are still open, waiting for it:** $3,150 twice, $2,690, $1,800, $500 and $460.

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

- An open offer canceled by escalation, in PayPal's own events (the $500 claim is set up for it, waiting for the balance).
- The contractor's evidence route, `POST /api/sim/contractor/:id/evidence`, in this run.
- The photo check on the demo photos reaches the demo claim: it answered $1,025.00, not $3,150.00, because the current photos do not show what the demo says. They will be replaced.
