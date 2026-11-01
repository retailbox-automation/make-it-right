import { describe, expect, it } from 'vitest';
import { PayPalClient, PayPalError } from '../../src/paypal/client.js';
import { buildOrderBody, captureOrder, createOrder, customIdFor, PAYMENT_METHOD, type OrderInput } from '../../src/paypal/orders.js';
import { fakePayPal, fixture, type Route } from '../helpers/fake-paypal.js';
import { item, RIDGEWAY_ITEMS } from '../helpers/demo.js';

const input = (over: Partial<OrderInput> = {}): OrderInput => ({
  case_id: 'B1-A',
  payee_name: 'Ridgeway Electric',
  promised_items: RIDGEWAY_ITEMS,
  return_url: 'http://localhost:8787/paypal/return',
  cancel_url: 'http://localhost:8787/paypal/cancel',
  ...over,
});

function clientFor(route: Route, ownedOrders: string[] = []) {
  const fake = fakePayPal(route);
  const client = new PayPalClient({
    clientId: 'id', clientSecret: 'secret', fetch: fake.fetch,
    owns: { order: (o) => ownedOrders.includes(o), dispute: () => false },
  });
  return { fake, client };
}

describe('order body', () => {
  it('has one purchase-unit item per promised item, and the amounts add up to the payment', () => {
    const body = buildOrderBody(input());
    const unit = body.purchase_units[0]!;
    expect(unit.items.map((i) => [i.name, i.quantity, i.unit_amount.value])).toEqual([
      ['GFCI outlets', '4', '65.00'],
      ['Ceiling fan', '1', '310.00'],
      ['Recessed lights', '6', '120.00'],
      ['Main panel upgrade', '1', '1800.00'],
      ['EV charger circuit', '1', '650.00'],
      ['Flood lights', '2', '230.00'],
    ]);
    expect(unit.amount).toEqual({ currency_code: 'USD', value: '4200.00', breakdown: { item_total: { currency_code: 'USD', value: '4200.00' } } });
    expect(body.intent).toBe('CAPTURE');
  });

  it('carries the case in a MIR- custom_id and a matching reference_id', () => {
    const unit = buildOrderBody(input()).purchase_units[0]!;
    expect(unit.custom_id).toBe('MIR-B1-A');
    expect(unit.reference_id).toBe('MIR-B1-A');
    expect(customIdFor('abc123')).toBe('MIR-abc123');
  });

  it('puts the contractor and the return links in the approval page settings', () => {
    const ctx = buildOrderBody(input()).payment_source.paypal.experience_context;
    expect(ctx).toEqual({
      user_action: 'CONTINUE',
      shipping_preference: 'NO_SHIPPING',
      brand_name: 'Ridgeway Electric',
      return_url: 'http://localhost:8787/paypal/return',
      cancel_url: 'http://localhost:8787/paypal/cancel',
    });
  });

  it('splits the price per unit when it divides evenly', () => {
    const unit = buildOrderBody(input({ promised_items: [item('1', 'Outlets', 7, '70.07')] })).purchase_units[0]!;
    expect(unit.items).toEqual([{ name: 'Outlets', quantity: '7', unit_amount: { currency_code: 'USD', value: '10.01' } }]);
  });

  it('keeps one unit and names the count when the price does not divide evenly', () => {
    const unit = buildOrderBody(input({ promised_items: [item('1', 'Interior doors', 3, '100.00'), item('2', 'Paint', 1, '50.00')] })).purchase_units[0]!;
    expect(unit.items).toEqual([
      { name: 'Interior doors (3)', quantity: '1', unit_amount: { currency_code: 'USD', value: '100.00' } },
      { name: 'Paint', quantity: '1', unit_amount: { currency_code: 'USD', value: '50.00' } },
    ]);
    expect(unit.amount.value).toBe('150.00');
  });

  it('refuses a punch list PayPal could not take', () => {
    const bad = (items: OrderInput['promised_items'], re: RegExp) => expect(() => buildOrderBody(input({ promised_items: items }))).toThrow(re);
    bad([], /at least one/);
    bad([item('1', 'Free work', 1, '0.00')], /price/);
    bad([item('1', 'Fan', 0, '10.00')], /quantity/);
    bad([item('1', 'Fan', 1.5, '10.00')], /quantity/);
    bad([item('1', '  ', 1, '10.00')], /title/);
    bad([item('1', 'x'.repeat(128), 1, '10.00')], /127/);
    bad([item('1', 'x'.repeat(125), 3, '100.00')], /127/); // "(3)" pushes the name over the limit
    expect(() => buildOrderBody(input({ case_id: 'a b' }))).toThrow(/case id/);
    expect(() => buildOrderBody(input({ payee_name: '' }))).toThrow(/payee/);
  });
});

describe('createOrder', () => {
  it('posts the order with a request id per case and returns the approval link', async () => {
    const { fake, client } = clientFor(() => ({ status: 200, body: fixture('order-created') }));
    const created = await createOrder(client, input());
    expect(created).toEqual({ order_id: '5X6481368Y377541C', status: 'PAYER_ACTION_REQUIRED', approve_url: 'https://www.sandbox.paypal.com/checkoutnow?token=5X6481368Y377541C' });
    const call = fake.calls[0]!;
    expect([call.method, call.path]).toEqual(['POST', '/v2/checkout/orders']);
    expect(call.headers['paypal-request-id']).toBe('mir-order-B1-A');
    expect(JSON.parse(call.body).purchase_units[0].custom_id).toBe('MIR-B1-A');
  });

  it('accepts the older "approve" link name too', async () => {
    const { client } = clientFor(() => ({ body: { id: 'O1', status: 'CREATED', links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/x', method: 'GET' }] } }));
    expect((await createOrder(client, input())).approve_url).toBe('https://www.sandbox.paypal.com/x');
  });

  it('fails loudly when PayPal returns no approval link', async () => {
    const { client } = clientFor(() => ({ body: { id: 'O1', status: 'CREATED', links: [] } }));
    await expect(createOrder(client, input())).rejects.toThrow(/approval link/);
  });
});

describe('captureOrder', () => {
  it('captures once per order id and reads the capture out of the answer', async () => {
    const { fake, client } = clientFor(() => ({ status: 201, body: fixture('order-captured') }), ['5X6481368Y377541C']);
    const captured = await captureOrder(client, '5X6481368Y377541C');
    expect(captured).toEqual({
      capture_id: '9UA851170T503222E',
      status: 'COMPLETED',
      captured_at: '2026-10-31T18:19:08Z',
      amount: '600.00',
      method: PAYMENT_METHOD,
    });
    expect(PAYMENT_METHOD).toBe('PayPal Goods & Services');
    const call = fake.calls[0]!;
    expect([call.method, call.path, call.body]).toEqual(['POST', '/v2/checkout/orders/5X6481368Y377541C/capture', '{}']);
    expect(call.headers['paypal-request-id']).toBe('mir-capture-5X6481368Y377541C');
  });

  it('passes PayPal\'s refusal on when the buyer has not approved yet', async () => {
    const { client } = clientFor(
      () => ({ status: 422, body: { name: 'UNPROCESSABLE_ENTITY', message: 'x', details: [{ issue: 'ORDER_NOT_APPROVED' }] } }),
      ['O1'],
    );
    const err = (await captureOrder(client, 'O1').catch((e) => e)) as PayPalError;
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.issue).toBe('ORDER_NOT_APPROVED');
  });

  it('refuses an order that is not in our store (the client guard)', async () => {
    const { fake, client } = clientFor(() => ({ body: {} }));
    await expect(captureOrder(client, 'SOMEONEELSES')).rejects.toThrow(/does not belong/);
    expect(fake.calls).toHaveLength(0);
  });

  it('fails when the answer holds no capture', async () => {
    const { client } = clientFor(() => ({ status: 201, body: { id: 'O1', status: 'COMPLETED', purchase_units: [{ payments: {} }] } }), ['O1']);
    await expect(captureOrder(client, 'O1')).rejects.toThrow(/no capture/);
  });
});
