// A small make-believe PayPal that answers like the recorded sandbox answers of case A in the spike:
// capture 9UA851170T503222E, claim PP-R-HAX-10195521. Tests move `world.dispute` through the recorded states.
import { PayPalClient } from '../../src/paypal/client.js';
import { MemoryStore } from '../../src/store.js';
import { ownershipFrom } from '../../src/ownership.js';
import { fakePayPal, fixture, type Call, type FakePayPal } from './fake-paypal.js';

export const CASE_ID = 'B1-A'; // custom_id MIR-B1-A, as in the recorded answers
export const ORDER_ID = '5X6481368Y377541C';
export const CAPTURE_ID = '9UA851170T503222E';
export const DISPUTE_ID = 'PP-R-HAX-10195521';

export interface World {
  fake: FakePayPal;
  client: PayPalClient;
  store: MemoryStore;
  /** What GET dispute answers; null = PayPal does not know the claim yet */
  dispute: Record<string, any> | null;
  /** Whether the list already shows the claim (PayPal lists it minutes after it exists) */
  listed: boolean;
  /** What PayPal answers to the next POST on an order or dispute, if not the plain "accepted" */
  postAnswer: ((call: Call) => { status?: number; body?: unknown } | undefined) | null;
  approved: boolean;
  /** Calls to the dispute endpoints and the list, in order */
  disputeCalls(): Call[];
}

export function makeWorld(): World {
  const store = new MemoryStore();
  const world: World = {
    fake: undefined as never,
    client: undefined as never,
    store,
    dispute: null,
    listed: false,
    postAnswer: null,
    approved: true,
    disputeCalls: () => world.fake.calls.filter((c) => c.path.startsWith('/v1/customer/disputes')),
  };
  world.fake = fakePayPal((call) => {
    if (call.method === 'POST' && call.path === '/v2/checkout/orders') return { body: fixture('order-created') };
    if (call.method === 'POST' && call.path === `/v2/checkout/orders/${ORDER_ID}/capture`) {
      return world.approved
        ? { status: 201, body: fixture('order-captured') }
        : { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', message: 'Payer has not approved', details: [{ issue: 'ORDER_NOT_APPROVED' }] } };
    }
    if (call.method === 'GET' && call.path === '/v1/customer/disputes') {
      return { body: world.listed && world.dispute ? fixture('disputes-list-by-capture') : { items: [], links: [] } };
    }
    if (call.method === 'GET' && call.path === `/v1/customer/disputes/${DISPUTE_ID}`) {
      return world.dispute ? { body: world.dispute } : { status: 404, body: { name: 'RESOURCE_NOT_FOUND' } };
    }
    if (call.method === 'POST' && call.path.startsWith(`/v1/customer/disputes/${DISPUTE_ID}/`)) {
      return world.postAnswer?.(call) ?? { body: fixture('action-accepted') };
    }
    return undefined;
  });
  world.client = new PayPalClient({ clientId: 'id', clientSecret: 'secret', fetch: world.fake.fetch, owns: ownershipFrom(store) });
  return world;
}
