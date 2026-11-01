// "Ours" means: recorded on a case in our store. The PayPal client asks this before it mutates anything.
import type { Ownership } from './paypal/client.js';
import type { Store } from './store.js';

export function ownershipFrom(store: Store): Ownership {
  return {
    order: (id) => store.hasOrder(id),
    dispute: (id) => store.hasDispute(id),
  };
}
