# Demo case: Ridgeway Electric

The files in this folder are the exact inputs of the photo check for the demo job, and its recorded answer. The hosted demo has no model; it replays this answer.

| File | What it is |
|---|---|
| `estimate.pdf` | The contractor's estimate the model read |
| `texts.txt` | The text messages between the homeowner and the contractor (5 messages) |
| `payment.json` | The payment as the homeowner gave it: date, amount, method, payee |
| `photos/photo-1.png` … `photos/photo-6.png` | The job-site photos the model judged; a verdict's `photo_ref` names one of them |
| `recorded-analysis.json` | The model's answer for this job, kept verbatim |

## How the answer was made

- Model: `gemma4:31b`, `num_ctx` 16384, run on our own machine with Ollama on 2026-11-06 (evaluation runner `eval/run.ts`, approach `a1-whole`).
- The same job was run 5 times; all 5 runs gave the same claim, 2650.00. `recorded-analysis.json` is the first of them (started 2026-11-06T18:43:30Z).
- The inputs are the files above, unchanged.

## What the app reads from the answer

- `extraction.items` become the promised items and `judge_e2e.verdicts` the verdicts (the judge run on the items the model found itself); the payee and the payment date come from `payment.json`. See `src/demo.ts`.
- Every amount on screen is computed again in `src/money.ts` from those items and verdicts. The `claim` block in the file is what the evaluation computed at the time; the app does not read it.
- `judge_true` is the judge run on the evaluation's own item list, used to score the model; the app does not use it.
- The evaluation's truth file for this job is not in this folder: it is the answer key of the evaluation, not model output.
