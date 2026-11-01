# Make It Right

Paid a contractor up front through PayPal, and the job was left half done? Make It Right reads the estimate, the text messages and the job-site photos, sorts every promised item on the punch list into done, partly done or not done, with a photo for each, and prepares a PayPal claim for exactly the unfinished work. You file the claim yourself in PayPal; the app then follows the contractor's offer, the escalation and the refund, and explains each step. It never moves money on its own.

Status: work in progress. PayPal **sandbox only**: no real money moves.

| Path | What it is |
|---|---|
| `src/model.ts`, `src/money.ts` | The data model of the screens and every amount, computed in integer cents |
| `src/core/` | The photo check: read the estimate (PDF text or image) and the texts, find the promised items, judge each one from the photos |
| `src/models/` | The vision model interface and a local Ollama client |
| `src/paypal/`, `src/disputes/`, `src/sandbox/` | PayPal sandbox client, orders made from the promised items, the claim tracker, and a contractor stand-in for the sandbox demo |
| `src/app.ts`, `src/server.ts` | HTTP API: `POST /api/cases/analyze` (estimate + texts + photos → case), payment, claim tracking, escalation helper |
| `eval/` | The evaluation runner, metrics and re-scoring |
| `design/screens/` | Reference HTML screens (static HTML/CSS, data slots marked for the app) |

## How the photo check is measured

Every amount is computed in code from the promised items and the photo verdicts; the model only reads documents and photos. A promised item counts as **done** only when a photo shows it finished, **partly done** only when it has more than one unit and a photo shows how many are finished, **not done** when a photo shows the place without it, and **no photo yet** when nothing shows it (it stays in the claim and the homeowner is asked for a photo). The contractor's words are never proof.

The evaluation set is synthetic: contractor jobs (electrical, plumbing and bath, interior, exterior, HVAC, yard) with generated estimates (PDF or a photo of a paper estimate) and text threads, and real job-site photos from Wikimedia Commons under CC0, public domain or CC BY. The truth for each photo was set by one automated reviewer and checked blind by a second; every finished job was checked again for photos that contradict each other, and contradicting items were corrected or removed. Traps include a false "all done" text, items added by text message, photos of work that was never promised, and items without any photo.

Results with Gemma 4 31B running locally (Ollama, temperature 0):

| Set | Verdicts correct | Claims exact to the cent | Promised items found (F1) | Done called not done | Not done called done |
|---|---|---|---|---|---|
| Development, 26 jobs / 100 items | 87 % | 18 of 26 | 1.000 | 2 of 42 | 2 of 32 |
| Held out, 12 jobs / 48 items (not used for tuning) | 91.7 % | 10 of 12 | 1.000 | 0 of 20 | 0 of 15 |
| Baseline without a model ("everything not done"), development set | 32 % | 2 of 26 | 0.773 | 42 of 42 | 0 of 32 |

Caveats: the sets are small and synthetic, the held-out jobs reuse photos from the same pool in new combinations, and counting finished units is the weakest part (5 of 7 partly done items right on the development set). The hosted model for the public demo is not chosen yet.

License: MIT, © 2026 RetailBox Automation, Inc. See `LICENSE`. Evaluation photos are credited to their authors on Wikimedia Commons.
