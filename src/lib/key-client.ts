const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL;

function getKeyServiceUrl(): string {
  if (!KEY_SERVICE_URL) throw new Error("KEY_SERVICE_URL is not set");
  return KEY_SERVICE_URL;
}

function getApiKey(): string {
  const key = process.env.KEY_SERVICE_API_KEY;
  if (!key) throw new Error("KEY_SERVICE_API_KEY is not set");
  return key;
}

export interface CallerContext {
  method: string;
  path: string;
}

export interface DecryptedKey {
  provider: string;
  key: string;
  keySource: "org" | "platform";
}

export class KeyServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "KeyServiceError";
  }
}

export interface ResolveKeyParams {
  provider: string;
  orgId: string;
  userId: string;
  caller: CallerContext;
}

/**
 * Resolve a key from key-service using auto-resolution.
 *
 * GET /keys/{provider}/decrypt?orgId=...&userId=...
 *
 * key-service auto-resolves the source (org key or platform key)
 * and returns { provider, key, keySource } where keySource is "org" | "platform".
 */
export async function resolveKey(params: ResolveKeyParams): Promise<DecryptedKey> {
  const { provider, orgId, userId, caller } = params;
  const base = getKeyServiceUrl();

  if (!orgId) throw new Error("orgId is required for key resolution");
  if (!userId) throw new Error("userId is required for key resolution");

  const url = `${base}/keys/${provider}/decrypt?orgId=${encodeURIComponent(orgId)}&userId=${encodeURIComponent(userId)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-api-key": getApiKey(),
      "x-caller-service": "scraping-service",
      "x-caller-method": caller.method,
      "x-caller-path": caller.path,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new KeyServiceError(
      `Key-service ${url} failed: ${response.status} - ${errorText}`,
      response.status
    );
  }

  return response.json() as Promise<DecryptedKey>;
}
