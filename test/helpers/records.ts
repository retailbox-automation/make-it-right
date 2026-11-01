import type { CaseRecord } from '../../src/model.js';
import { CAPTURE_ID, CASE_ID, ORDER_ID } from './world.js';
import { RIDGEWAY_ITEMS, RIDGEWAY_VERDICTS } from './demo.js';

export const NOW = new Date('2026-11-01T12:00:00.000Z');

export function paidCase(over: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: CASE_ID,
    created_at: '2026-11-01T10:00:00.000Z',
    payee_name: 'Ridgeway Electric',
    promised_items: RIDGEWAY_ITEMS,
    verdicts: RIDGEWAY_VERDICTS,
    paid_at: '2026-09-12',
    payment: { order_id: ORDER_ID, approve_url: `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`, status: 'captured', capture_id: CAPTURE_ID, capture_status: 'COMPLETED', captured_at: '2026-10-31T18:19:08Z', method: 'PayPal Goods & Services' },
    buyer_transaction_id: null,
    dispute: null,
    offer: null,
    outcome: null,
    ...over,
  };
}
