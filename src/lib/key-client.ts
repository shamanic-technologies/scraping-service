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

export async function decryptByokKey(
  provider: string,
  clerkOrgId: string,
  caller: CallerContext
): Promise<DecryptedKey> {
  const url = `${getKeyServiceUrl()}/internal/keys/${provider}/decrypt?clerkOrgId=${encodeURIComponent(clerkOrgId)}`;

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
      `Key-service GET /internal/keys/${provider}/decrypt failed: ${response.status} - ${errorText}`,
      response.status
    );
  }

  return response.json() as Promise<DecryptedKey>;
}
