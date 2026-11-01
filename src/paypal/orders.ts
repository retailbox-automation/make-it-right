// The payment: an order whose items are the promised items, so PayPal's claim form lists the same rows as our screen.
import type { PromisedItem } from '../model.js';
import { fromCents, toCents } from '../money.js';
import { CUSTOM_ID_PREFIX, PayPalError, type PayPalClient } from './client.js';

export const PAYMENT_METHOD = 'PayPal Goods & Services';
const NAME_LIMIT = 127; // PayPal's limit for an item name and for the brand name

export interface OrderInput {
  case_id: string;
  payee_name: string;
  promised_items: PromisedItem[];
  return_url: string;
  cancel_url: string;
}

interface Money {
  currency_code: 'USD';
  value: string;
}

export interface OrderBody {
  intent: 'CAPTURE';
  purchase_units: Array<{
    reference_id: string;
    custom_id: string;
    amount: Money & { breakdown: { item_total: Money } };
    items: Array<{ name: string; quantity: string; unit_amount: Money }>;
  }>;
  payment_source: {
    paypal: {
      experience_context: {
        user_action: 'CONTINUE';
        shipping_preference: 'NO_SHIPPING';
        brand_name: string;
        return_url: string;
        cancel_url: string;
      };
    };
  };
}

export function customIdFor(caseId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error(`case id "${caseId}" cannot go into a custom_id`);
  return `${CUSTOM_ID_PREFIX}${caseId}`;
}

const usd = (cents: number): Money => ({ currency_code: 'USD', value: fromCents(cents) });

/**
 * One order item per promised item. When the price divides evenly by the quantity the item keeps its quantity
 * (4 outlets at $65.00); otherwise it becomes one unit and the name carries the count ("Interior doors (3)").
 */
export function buildOrderBody(input: OrderInput): OrderBody {
  const customId = customIdFor(input.case_id);
  if (!input.payee_name.trim()) throw new Error('payee name is empty');
  if (input.promised_items.length === 0) throw new Error('an order needs at least one promised item');

  let total = 0;
  const items = input.promised_items.map((promised) => {
    const title = promised.title.trim();
    if (!title) throw new Error(`item ${promised.id}: title is empty`);
    if (!Number.isInteger(promised.qty) || promised.qty < 1) throw new Error(`item ${promised.id}: quantity must be a whole number, 1 or more`);
    const price = toCents(promised.price);
    if (price < 1) throw new Error(`item ${promised.id}: price must be more than zero`);
    total += price;
    const even = price % promised.qty === 0;
    const name = even ? title : `${title} (${promised.qty})`;
    if (name.length > NAME_LIMIT) throw new Error(`item ${promised.id}: name is longer than ${NAME_LIMIT} characters`);
    return even
      ? { name, quantity: String(promised.qty), unit_amount: usd(price / promised.qty) }
      : { name, quantity: '1', unit_amount: usd(price) };
  });

  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: customId,
        custom_id: customId,
        amount: { ...usd(total), breakdown: { item_total: usd(total) } },
        items,
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          user_action: 'CONTINUE',
          shipping_preference: 'NO_SHIPPING',
          brand_name: input.payee_name.trim().slice(0, NAME_LIMIT),
          return_url: input.return_url,
          cancel_url: input.cancel_url,
        },
      },
    },
  };
}

export interface CreatedOrder {
  order_id: string;
  status: string;
  approve_url: string;
}

export async function createOrder(client: PayPalClient, input: OrderInput): Promise<CreatedOrder> {
  const response = await client.request<{ id?: string; status?: string; links?: Array<{ rel: string; href: string }> }>('POST', '/v2/checkout/orders', {
    json: buildOrderBody(input),
    requestId: `mir-order-${input.case_id}`,
  });
  const approve = response.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
  if (!response.id || !approve) throw new Error('PayPal created no order id or approval link');
  return { order_id: response.id, status: response.status ?? 'CREATED', approve_url: approve };
}

export interface Capture {
  capture_id: string;
  /** PayPal's capture status; the payment is paid only when this is COMPLETED */
  status: string;
  /** ISO time PayPal gives for the capture */
  captured_at: string;
  amount: string;
  method: string;
}

interface RawCapture {
  id: string;
  status: string;
  create_time: string;
  amount: { value: string };
}

interface RawOrder {
  purchase_units?: Array<{ payments?: { captures?: RawCapture[] } }>;
}

const toCapture = (raw: RawCapture): Capture => ({
  capture_id: raw.id,
  status: raw.status,
  captured_at: raw.create_time,
  amount: fromCents(toCents(raw.amount.value)),
  method: PAYMENT_METHOD,
});

function captureOf(order: RawOrder, orderId: string): Capture {
  const raw = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (!raw) throw new Error(`PayPal returned no capture for order ${orderId}`);
  return toCapture(raw);
}

/**
 * Takes the money. PayPal may answer with a capture that is not COMPLETED yet (PENDING); the caller keeps its id and asks
 * again with readCapture. If the order was captured already (an earlier answer got lost), the capture is read from the order.
 */
export async function captureOrder(client: PayPalClient, orderId: string): Promise<Capture> {
  try {
    const response = await client.request<RawOrder>('POST', `/v2/checkout/orders/${orderId}/capture`, { json: {}, requestId: `mir-capture-${orderId}` });
    return captureOf(response, orderId);
  } catch (error) {
    if (!(error instanceof PayPalError) || error.issue !== 'ORDER_ALREADY_CAPTURED') throw error;
    return captureOf(await client.request<RawOrder>('GET', `/v2/checkout/orders/${orderId}`), orderId);
  }
}

/** The capture as it is now. Used instead of capturing again once PayPal gave us a capture id. */
export async function readCapture(client: PayPalClient, captureId: string): Promise<Capture> {
  return toCapture(await client.request<RawCapture>('GET', `/v2/payments/captures/${captureId}`));
}
