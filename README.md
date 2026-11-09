# Make It Right

**Paid the contractor $3,700. The job is half done. Claim: $2,650. You file it yourself on PayPal.**

Make It Right is for the job you already paid for. It reads the estimate, the text messages and the job-site photos, sorts every promised item on the punch list into done, partly done or not done, with a photo for each, and prepares a PayPal claim for exactly the unfinished work. You file the claim yourself on PayPal; the app finds it, then follows the contractor's offer, the escalation and the refund, and explains each step. It never moves money on its own.

PayPal **sandbox only**: no real money moves.

## Judging Make It Right? Try it in about 3 minutes

Demo: **https://makeitright.retailbox-automation.com** (no login).

1. **Open the walkthrough** to see the demo case: what Ridgeway Electric (a made-up contractor) promised, what each photo shows, and the claim the app computes. Read-only.
2. **Start with your PayPal sandbox account** makes your own copy of the demo case. Log in with your own PayPal sandbox Personal account and approve the $3,700.00 payment (sandbox money).
3. Back in the app, press **File with PayPal** and file "Service not received" in the sandbox Resolution Center for the amounts the claim screen shows ($2,650.00 in total).
4. The app finds your claim within a few minutes (3 to 4 in our sandbox runs). On the offer screen, **Sandbox stand-in: contractor makes an offer**, then accept it on PayPal or press **Ask PayPal to decide** (the hosted demo allows 5 such sandbox refunds a day, because the sandbox seller is shared). The money-back screen shows the outcome.

No credentials of ours are needed. The photo check on the hosted demo replays a recorded analysis (see below); every PayPal call is live, in the sandbox.

## What you can check, and where

| Claim | Proof | What you will see |
|---|---|---|
| The model only reads; every amount is computed in code | `src/money.ts` (integer cents), `src/demo.ts`; tests `test/demo.test.ts` change one verdict and get a different claim | claim screen: $3,700.00 paid − $1,050.00 proven = $2,650.00 |
| The photo check is Gemma 4 31B, and the hosted demo replays its recorded answer | `demo/ridgeway/recorded-analysis.json` (verbatim), `demo/ridgeway/PROVENANCE.md`: the same claim, 2650.00, in 5 runs out of 5 | the note "Photo check: recorded analysis by Gemma 4 31B" on every screen |
| The payment is a PayPal order made of the promised items | `src/paypal/orders.ts` | your sandbox account shows the order with its six items; PayPal's claim form lists them one by one |
| The app finds the homeowner's claim by itself | `src/disputes/tracker.ts`, `docs/paypal-notes.md` § How the tracker finds the claim | the claim screen says when you filed and for how much, and the offer screen follows PayPal's status, without you typing the claim id anywhere |
| The whole claim path ran on real sandbox claims | `docs/sandbox-evidence.md`: offer accepted ($460 → $300), contractor accepts ($400), offer declined and PayPal decides ($1,350 back, 12 min 9 s after filing) | claim ids and PayPal's outcomes |
| The photo check is measured, with its limits | the table below; runner in `eval/` | 91.7 % of verdicts right on 12 held-out jobs |

## How AI is used

- **Model:** Gemma 4 31B, an open model, run with Ollama on our own machine (temperature 0, strict JSON schema).
- **What it does:** reads the estimate (PDF text, or an image of a paper estimate) and the text messages, lists the promised items with where each was promised, then judges each item from the job-site photos: done, partly done (how many units), not done, or no photo yet.
- **What it never does:** compute money or move it. The claim is computed in code from the items and the verdicts; a contractor's words are never proof.
- **On the hosted demo:** there is no model on the server. The demo case shows the model's recorded answer for that case (`demo/ridgeway/`), and `POST /api/cases/analyze` answers 503. To run the photo check live on your own files, see "Run it yourself".

## How PayPal is used (sandbox)

- **Orders v2:** the payment is created with the promised items as order items and a `custom_id` starting with `MIR-`, then captured after the homeowner approves it.
- **Disputes API:** a tracker lists claims every minute and matches them to our payments, reads the homeowner's own transaction id from the claim, and maps PayPal's answers to offer, escalation and outcome. A contractor stand-in makes an offer (`make-offer`) or accepts the claim (`accept-claim`); escalation (`escalate`); and, in the sandbox only, PayPal's decision (`adjudicate`).
- **The homeowner files the claim on PayPal's site.** PayPal has no API for a buyer to open a claim (our call on the homeowner's behalf answered 400), so the app prepares the amount and the proof per item and the homeowner files it.
- Guards: sandbox base URL only; no webhook calls (the PayPal app is shared, so the app polls); POST and PATCH only on orders and claims recorded on our own cases. Details: `docs/paypal-notes.md`.

## Run it yourself

Requirements: Node 22, a PayPal developer sandbox app (client id and secret). For the live photo check, Ollama with `gemma4:31b`.

```sh
npm ci
npm test
PAYPAL_SANDBOX_CLIENT_ID=... PAYPAL_SANDBOX_CLIENT_SECRET=... MIR_POLL_SECONDS=60 npm start   # http://localhost:8787
# live photo check (optional): MIR_VISION_MODEL=ollama:gemma4:31b (MIR_OLLAMA_URL, MIR_NUM_CTX)
```

Put the two sandbox credentials in the environment from your own secret store, not on the command line. Other settings: `PORT`, `MIR_DATA_DIR`, `MIR_RETURN_URL`, `MIR_CANCEL_URL`, `MIR_CALL_JOURNAL` (see `src/config.ts`). `MIR_PUBLIC_DEMO=1` turns on the hosted demo's limits, because the sandbox seller and the PayPal app are shared: cases only from the demo template; daily caps on new live cases (`MIR_DEMO_CASES_PER_ADDRESS_PER_DAY`, default 25, `MIR_DEMO_CASES_PER_DAY`, default 60); a limit on steps that call PayPal (`MIR_DEMO_ACTIONS_PER_ADDRESS` per `MIR_DEMO_ACTIONS_WINDOW_MINUTES`, default 30 per 10 minutes); and at most `MIR_DEMO_REFUNDS_PER_DAY` (default 5) refunds a day that the app itself triggers (PayPal deciding in the sandbox, or the stand-in accepting a claim).

The hosted demo runs from the `Dockerfile`: `tools/docker-entrypoint.sh` reads the service's secrets from a vault at start (`infisical run`), refuses to start without them, and runs the app as an unprivileged user.

| Path | What it is |
|---|---|
| `src/model.ts`, `src/money.ts` | The data model of the screens and every amount, computed in integer cents |
| `src/core/` | The photo check: read the estimate and the texts, find the promised items, judge each one from the photos |
| `src/models/` | The vision model interface and a local Ollama client |
| `src/paypal/`, `src/disputes/`, `src/sandbox/` | PayPal sandbox client, orders made from the promised items, the claim tracker, and a contractor stand-in for the sandbox demo |
| `src/app.ts`, `src/server.ts`, `src/web.ts` | HTTP API and the web screens |
| `src/demo.ts`, `demo/ridgeway/` | The demo case: the photo check's exact inputs and its recorded answer |
| `web/` | The four screens: promised items, claim, contractor's offer, money back |
| `eval/` | The evaluation runner, metrics and re-scoring |
| `design/screens/` | The static reference screens the web screens were built from |

## How the photo check is measured

Every amount is computed in code from the promised items and the photo verdicts; the model only reads documents and photos. A promised item counts as **done** only when a photo shows it finished, **partly done** only when it has more than one unit and a photo shows how many are finished, **not done** when a photo shows the place without it, and **no photo yet** when nothing shows it (it stays in the claim and the homeowner is asked for a photo). The contractor's words are never proof.

The evaluation set is synthetic: contractor jobs (electrical, plumbing and bath, interior, exterior, HVAC, yard) with generated estimates (PDF or a photo of a paper estimate) and text threads, and real job-site photos from Wikimedia Commons under CC0, public domain or CC BY. The truth for each photo was set by one automated reviewer and checked blind by a second; every finished job was checked again for photos that contradict each other, and contradicting items were corrected or removed. Traps include a false "all done" text, items added by text message, photos of work that was never promised, and items without any photo.

Results with Gemma 4 31B running locally (Ollama, temperature 0):

| Set | Verdicts correct | Claims exact to the cent | Promised items found (F1) | Done called not done | Not done called done |
|---|---|---|---|---|---|
| Development, 26 jobs / 100 items | 87 % | 18 of 26 | 1.000 | 2 of 42 | 2 of 32 |
| Held out, 12 jobs / 48 items (not used for tuning) | 91.7 % | 10 of 12 | 1.000 | 0 of 20 | 0 of 15 |
| Baseline without a model ("everything not done"), development set | 32 % | 2 of 26 | 0.773 | 42 of 42 | 0 of 32 |

Caveats: the sets are small and synthetic, the held-out jobs reuse photos from the same pool in new combinations, and counting finished units is the weakest part (5 of 7 partly done items right on the development set).

**The demo case is not a real job.** Its photos are generated images, made so that each photo shows one promised item; its estimate is generated by code. The evaluation set above uses real photos from Wikimedia Commons.

## Hackathon requirements

- PayPal developer platform, sandbox: Orders v2 and the Disputes API (above).
- AI: Gemma 4 31B reads the documents and judges the photos (above).
- Working demo: https://makeitright.retailbox-automation.com
- Open source: MIT license, `LICENSE`.

License: MIT, © 2026 RetailBox Automation, Inc. See `LICENSE`. The evaluation photos are not stored in this repository; each comes from Wikimedia Commons under CC0, public domain or CC BY and is credited to its author there.
