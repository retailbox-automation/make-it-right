# Make It Right — reference screens

Static HTML references for the four product screens. They set the look; the app wires the same structure to its data. No JavaScript and no libraries: icons and stamps are HTML/CSS or inline SVG, photos are local PNGs in each `assets/` folder. Fonts: Source Serif 4 for text, IBM Plex Mono for amounts (Google Fonts). Colors live in two `:root` blocks at the top of each file: the shared product tokens first, the screen's own values second.

Demo data only: the contractor is the fictional "Ridgeway Electric". The homeowner paid $3,700.00 up front on Sep 12 with PayPal Goods & Services. The punch list has six promised items: GFCI outlets $260 (done), ceiling fan $310 (done), six recessed lights $720 (4 of 6 done, so $240 stays in the claim), main panel upgrade $1,300, EV charger circuit $650 and two flood lights $460 (not done). Photos prove $1,050 of work; the claim is $2,650. On every screen the work removed from the claim and the claim add up to exactly $3,700.

| Screen | File | Width | What it shows |
|---|---|---|---|
| Promised items | `promised/index.html` | 1440 px | what the contractor promised, found in the estimate, texts and photos; can PayPal help |
| Claim (key screen) | `claim/index.html` | 1440 px, and 390 px below 600 px | each unfinished item next to the photo that shows it; finished work moved to "Removed from claim"; the "File with PayPal" button |
| Contractor's offer | `offer/index.html` | 1440 px | the offer against the claim, item by item, with our read; the homeowner decides |
| Money back | `money-back/index.html` | 430 px (phone) | the refund, the case timeline, and what the contractor kept |

Open any file directly in a browser.

## Product rules the screens assume

- The homeowner files the claim. The "File with PayPal" button opens PayPal's Resolution Center for the payment; the app prepares the amount and the proof for each item, it does not file on its own.
- PayPal's claim form lists the order items, each with its own refund amount, so the app should create the payment with the six promised items as order items. The amount per item on our screen then goes into PayPal's field one to one.
- The claim reason is "Service not received" (`MERCHANDISE_OR_SERVICE_NOT_RECEIVED`).
- Accepting a contractor's offer happens on PayPal's site, so "Accept" on the offer screen is a link to the Resolution Center. "Ask PayPal to decide" is the escalation the app can send itself.
- Once an offer is accepted, PayPal overwrites the case amount with the offer; keep the original claim amount on our side.
- A refund goes back to the payment method the homeowner used (for example their bank account), not to a PayPal balance.
- Every amount on screen is computed in code from the item list and the photo verdicts; nothing is typed by hand.
- The agent explains and counts; only the homeowner moves money.

## How to wire them

Every dynamic value carries `data-field="…"`. Grey placeholder bars are kept on purpose and carry `data-slot="…"`: they mark where secondary text goes, in the same muted style. Item rows and cards carry `data-item="…"` with the item id. Two names are used on every screen: `payee` is the contractor's name (proposed field `claim.payee_name`, from the payment), and `claim_amount` / `proven_done` are the claim and the proven work.

The object names below (`promised_item`, `verdict`, `claim`, `filing`, `dispute`, `offer`, `outcome`) are the app's data model:

| Object | Fields |
|---|---|
| `promised_item` | id, title, qty, price, source {kind: estimate / text / photo, ref, date, quote} |
| `verdict` | item_id, status done / partial / not_done, fraction (4/6), photo_ref, note |
| `claim` | amount (sum of unfinished work), proven_done (paid − amount), payee_name, reason, transaction_id, paid_at, method, day_n of 180, eligibility_note |
| `filing` | filing_url (Resolution Center for the transaction), proof per item (jpg / png / pdf), filed_at |
| `dispute` | id, status, life_cycle_stage, opened_at, escalated_at |
| `offer` | amount, type REFUND, note, received_at, status |
| `outcome` | status, amount_refunded, refund_destination, decided_at |

`source.quote`, `claim.payee_name`, `dispute.escalated_at`, `offer.status` and `outcome.refund_destination` are additions the screens need.

### Promised items (`promised/index.html`)

| Name | Data |
|---|---|
| `payee` | contractor name in the heading |
| `source_photo`, `source_name`, `source_date`, `source_count` | source cards: preview image, "Estimate.pdf" / "Text messages" / "Job-site photos", date, count (5 texts, 6 photos) |
| slot `sources-meta`, `estimate-summary-1/2`, `texts-summary-1/2`, `photos-summary-1/2` | what was read from each source |
| `data-item`, `title`, `price`, `source` | one row per promised item: title (with qty), price, source tag ("estimate p.1", "text Sep 9") |
| slot `items-meta` | item count |
| `paid_total` | sum of the item prices = the payment ($3,700.00) |
| `method_check`, `method` | check 1: paid with PayPal Goods & Services |
| `window_check`, `paid_at`, `day_n` | check 2: payment date and day N of 180 |
| `eligibility_icon`, `eligibility_note` | line 3 is a neutral note, not a check: "may be eligible · PayPal decides" |
| `next_url` | "Check the photos" button |
| slot `help-note-1…3`, `footer-1…3`, `footer-status`, `nav-1…3` | secondary text, footer, navigation |

### Claim (`claim/index.html`)

| Name | Data |
|---|---|
| `paid_amount`, `proven_done`, `claim_amount` | the heading sentence and the summary: paid, proven (shown negative), claim |
| `payee`, `paid_at`, `method`, `reason` | top of the summary column |
| `filing_url` | "File with PayPal" (a link) |
| `data-item` on each card | item id |
| `item_title`, `item_price` | item name and price; in the "Removed from claim" tray the price is the proven part (4 of 6 lights = $480) |
| `item_claim` | the claimed part of a partly done item ("$240" of "$720"), computed in code |
| `promise_quote`, `promise_source`, `promise_date` | the promise, quoted from the estimate or a text, with source and date |
| `photo` | the job-site photo for the verdict |
| `verdict`, `verdict_fraction` | stamp: Not done / Partly · 4 of 6 / Done |
| slot `verdict-note` | a short note under each verdict |
| slot `transaction-id`, `eligibility`, `dispute-status`, `nav-1…3` | summary column extras; `dispute-status` stays empty until the claim is filed |

Below 600 px the same blocks restack in one column: heading, summary with the button, the four claim cards, then the tray. Stamps scale with the photo (container units), so they keep covering the same corner.

### Contractor's offer (`offer/index.html`)

| Name | Data |
|---|---|
| `payee`, `offer_amount` | heading: "Ridgeway Electric offered $1,200.00"; the offer amount also appears in "Their offer" and on the Accept link |
| `filed_at`, `claim_amount`, `claim_reason` | the filing strip: "You filed Nov 4 · $2,650.00 · Service not received"; `claim_amount` again under "Your claim" |
| `data-item`, `item_title`, `item_claim_amount`, `verdict_status` | one row per claimed item: short title, the amount it adds to the claim, the Not done / Partly tag |
| `verdict_remaining`, `item_qty` | the partly done row: "2 of 6 lights" (2 = 6 − 4 done) |
| `read_note`, `offer_gap` | "Our read": the explanation and the unpaid gap ($2,650.00 − $1,200.00 = $1,450.00), computed in code |
| `escalate` | "Ask PayPal to decide" (a button: the app escalates the case itself) |
| `resolution_center_url` | "Accept $1,200.00" (a link with an external-link mark: the homeowner accepts on PayPal's site) |
| slot `claim-note-1`, `claim-note-2`, `nav-1…3` | payment details and the 180-day window under the claim list; navigation |

### Money back (`money-back/index.html`)

| Name | Data |
|---|---|
| `outcome_status` | the "Money back" stamp |
| `amount_refunded` | "+$2,650.00" |
| slot `refund-detail`, `refund-ref` | where the money went (bank, last digits) and the case / transaction ids |
| `filed_at`, `claim_amount` | step 1: filed in PayPal, claim amount |
| `offer_received_at`, `offer_amount`, `offer_status` | step 2: the offer and the homeowner's answer ("declined") |
| `escalated_at` | step 3: sent to PayPal |
| `decided_at`, `outcome_text` | step 4: decided in the homeowner's favor |
| `payee`, `proven_done` | "Kept by Ridgeway: $1,050.00 for work the photos prove" |
| slot `case-title`, `case-meta`, `step-*-note`, `kept-detail`, `kept-ref` | secondary text |
