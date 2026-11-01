// A model that reads text and images and answers with JSON that matches a schema.
// The core asks it to read documents and photos; it never computes amounts (src/money.ts does).

export interface VisionRequest {
  system: string;
  prompt: string;
  /** Images in the order the prompt names them */
  images?: Buffer[];
  /** JSON schema the answer must follow */
  schema: object;
  maxTokens?: number;
}

export interface VisionModel {
  name: string;
  json<T>(req: VisionRequest): Promise<{ value: T; ms: number; raw: string }>;
}

/**
 * timeout        — no answer within the time limit
 * invalid_json   — the answer was not JSON (after one retry)
 * invalid_output — JSON, but not the shape the core asked for
 * http           — the model server answered with an error status
 * network        — the model server could not be reached
 */
export type ModelErrorKind = 'timeout' | 'invalid_json' | 'invalid_output' | 'http' | 'network';

export class ModelError extends Error {
  constructor(
    readonly kind: ModelErrorKind,
    message: string,
    readonly raw?: string,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}
