// Read-only checks against the PayPal SANDBOX, plus one unapproved order to prove the request shape.
// Run it through the wrapper that injects the sandbox credentials, never with them in the command line:
//   VAULT_EGRESS_OK=api-m.sandbox.paypal.com tools/lbl/with-sandbox-env.sh npx tsx scripts/live-check.ts <command>
// Commands: research | disputes | list | smoke-order
// It prints statuses, ids and field names. It never prints credentials, tokens or e-mail addresses.
import { PayPalClient, PayPalError, type JournalEntry } from '../src/paypal/client.js';
import { belongsToCase, buyerTransactionId, getDispute, listDisputes, mapDispute, mapOffer, mapOutcome } from '../src/paypal/disputes.js';
import { createOrder } from '../src/paypal/orders.js';
import { item } from '../test/helpers/demo.js';

// The three claims of the 31 Oct 2026 spike: capture, buyer transaction, dispute id, custom_id
const SPIKE = [
  { label: 'A (offer accepted)', capture: '9UA851170T503222E', order: '5X6481368Y377541C', buyer: '27S431280V029084G', dispute: 'PP-R-HAX-10195521', custom: 'MIR-B1-A' },
  { label: 'B (escalate, adjudicate)', capture: '08682011KF7334723', order: '09758334CT245754M', buyer: '36H69778E4891824M', dispute: 'PP-R-GWA-10195522', custom: 'MIR-B1-B' },
  { label: 'C (contractor accepts)', capture: '1KM933510K488100A', order: '7K922283FJ118083U', buyer: '3N732607MB758071P', dispute: 'PP-R-XJB-10195596', custom: 'MIR-B1-C' },
];

const journal: JournalEntry[] = [];
const clientId = process.env.PAYPAL_SANDBOX_CLIENT_ID;
const clientSecret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET;
if (!clientId || !clientSecret) throw new Error('missing PAYPAL_SANDBOX_CLIENT_ID / PAYPAL_SANDBOX_CLIENT_SECRET (run through the wrapper)');
const paypal = new PayPalClient({ clientId, clientSecret, journal: (e) => journal.push(e) });

const keys = (o: unknown): string[] => (o && typeof o === 'object' ? Object.keys(o) : []);
const contains = (body: unknown, needle: string) => JSON.stringify(body).includes(needle);

async function attempt<T>(label: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PayPalError) console.log(`${label}: HTTP ${error.status} ${error.paypalName ?? ''} ${error.issue ?? ''} debug_id=${error.debugId ?? '-'} | ${error.message.slice(0, 300)}`);
    else console.log(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function research() {
  const a = SPIKE[0]!;
  console.log(`Is the buyer's transaction id (${a.buyer}) visible to the seller before a dispute exists? Reads only.`);
  const capture = await attempt('GET capture', () => paypal.request('GET', `/v2/payments/captures/${a.capture}`));
  if (capture) console.log('GET capture: 200 keys=', keys(capture).join(','), '| related_ids=', keys((capture as any).supplementary_data?.related_ids).join(','), '| buyer id present:', contains(capture, a.buyer));
  const order = await attempt('GET order', () => paypal.request('GET', `/v2/checkout/orders/${a.order}`));
  if (order) {
    const cap = (order as any).purchase_units?.[0]?.payments?.captures?.[0];
    console.log('GET order: 200 keys=', keys(order).join(','), '| capture keys=', keys(cap).join(','), '| buyer id present:', contains(order, a.buyer));
  }
  const report = await attempt('GET reporting', () =>
    paypal.request('GET', '/v1/reporting/transactions', { query: { transaction_id: a.capture, start_date: '2026-10-31T00:00:00Z', end_date: '2026-11-01T23:59:59Z', fields: 'all' } }),
  );
  if (report) {
    const details = ((report as any).transaction_details ?? []) as any[];
    console.log('GET reporting: 200 transactions=', details.length, '| transaction_info keys=', keys(details[0]?.transaction_info).join(','), '| other sections=', keys(details[0]).join(','), '| buyer id present:', contains(report, a.buyer));
  }
  const dispute = await attempt('GET dispute', () => getDispute(paypal, a.dispute));
  if (dispute) console.log('GET dispute (after the claim exists): buyer id present:', contains(dispute, a.buyer), '| buyer_transaction_id =', buyerTransactionId(dispute, { capture_id: a.capture, custom_id: a.custom }));
}

async function disputes() {
  for (const s of SPIKE) {
    const raw = await attempt(`GET ${s.dispute}`, () => getDispute(paypal, s.dispute));
    if (!raw) continue;
    const dispute = mapDispute(raw, { previous: null, claim_amount: '400.00' });
    console.log(
      `${s.label}: ${s.dispute} belongs to case: ${belongsToCase(raw, { capture_id: s.capture, custom_id: s.custom })} | status=${dispute.status} stage=${dispute.life_cycle_stage} amount=${dispute.dispute_amount} original=${dispute.original_claim_amount} escalated_at=${dispute.escalated_at}`,
    );
    console.log('   offer  =', JSON.stringify(mapOffer(raw)));
    console.log('   outcome=', JSON.stringify(mapOutcome(raw)));
  }
}

/** The tracker's own query, exactly as the code sends it: ?disputed_transaction_id=<capture id>&page_size=20 */
async function list() {
  const a = SPIKE[0]!;
  const items = await attempt('GET dispute list', () => listDisputes(paypal, { disputed_transaction_id: a.capture }));
  if (items) {
    console.log(`GET dispute list for capture ${a.capture}: 200 items=${items.length} ids=${items.map((i) => i.dispute_id).join(',')} | item keys=${keys(items[0]).join(',')}`);
    console.log('   expected dispute listed:', items.some((i) => i.dispute_id === a.dispute));
  }
}

async function smokeOrder() {
  const created = await attempt('POST order', () =>
    createOrder(paypal, {
      case_id: 'B4-SMOKE-1',
      payee_name: 'Ridgeway Electric',
      promised_items: [item('1', 'GFCI outlets', 4, '260.00'), item('2', 'Recessed lights', 6, '720.00'), item('3', 'Interior doors', 3, '100.00')],
      return_url: 'http://localhost:8765/mir/return',
      cancel_url: 'http://localhost:8765/mir/cancel',
    }),
  );
  if (created) console.log(`POST order: 200 order_id=${created.order_id} status=${created.status} approve_url_host=${new URL(created.approve_url).host} (not approved, not captured)`);
}

const commands: Record<string, () => Promise<void>> = { research, disputes, list, 'smoke-order': smokeOrder };
const command = process.argv[2] ?? '';
const run = commands[command];
if (!run) throw new Error(`usage: live-check.ts ${Object.keys(commands).join(' | ')}`);
await run();
console.log('--- call journal (method path status ms debug_id)');
for (const e of journal) console.log(`${e.method} ${e.path} ${e.status} ${e.ms}ms ${e.debug_id ?? '-'}`);
