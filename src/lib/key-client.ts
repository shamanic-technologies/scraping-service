import type { KeySource } from "../schemas.js";

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
  keySource: KeySource;
  orgId?: string;
  appId?: string;
  caller: CallerContext;
}

/**
 * Resolve a key from key-service based on keySource.
 *
 * - "byok"     → GET /internal/keys/{provider}/decrypt?orgId=...
 * - "app"      → GET /internal/app-keys/{provider}/decrypt?appId=...
 * - "platform" → GET /internal/platform-keys/{provider}/decrypt
 */
export async function resolveKey(params: ResolveKeyParams): Promise<DecryptedKey> {
  const { provider, keySource, orgId, appId, caller } = params;
  const base = getKeyServiceUrl();

  let url: string;
  switch (keySource) {
    case "byok": {
      if (!orgId) throw new Error("orgId is required for keySource 'byok'");
      url = `${base}/internal/keys/${provider}/decrypt?orgId=${encodeURIComponent(orgId)}`;
      break;
    }
    case "app": {
      if (!appId) throw new Error("appId is required for keySource 'app'");
      url = `${base}/internal/app-keys/${provider}/decrypt?appId=${encodeURIComponent(appId)}`;
      break;
    }
    case "platform": {
      url = `${base}/internal/platform-keys/${provider}/decrypt`;
      break;
    }
  }

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

/**
 * @deprecated Use resolveKey() with explicit keySource instead.
 */
export async function decryptByokKey(
  provider: string,
  orgId: string,
  caller: CallerContext
): Promise<DecryptedKey> {
  return resolveKey({ provider, keySource: "byok", orgId, caller });
}
