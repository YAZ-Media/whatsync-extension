const TOKEN_PREFIX = "enc:v1:";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function encryptionKey(): Promise<CryptoKey> {
  const encoded = Deno.env.get("HUBSPOT_TOKEN_ENCRYPTION_KEY")?.trim();
  if (!encoded) throw new Error("HubSpot token encryption is not configured");
  const raw = base64ToBytes(encoded);
  if (raw.byteLength !== 32) {
    throw new Error("HubSpot token encryption key must be 32 bytes");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function isEncryptedHubSpotToken(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(TOKEN_PREFIX);
}

export async function encryptHubSpotToken(value: string | null | undefined): Promise<string | null> {
  if (!value) return null;
  if (isEncryptedHubSpotToken(value)) return value;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(value);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(), plaintext),
  );
  return `${TOKEN_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(ciphertext)}`;
}

export async function decryptHubSpotToken(value: string | null | undefined): Promise<string | null> {
  if (!value) return null;
  if (!isEncryptedHubSpotToken(value)) return value;
  const [ivPart, ciphertextPart] = value.slice(TOKEN_PREFIX.length).split(":");
  if (!ivPart || !ciphertextPart) throw new Error("Stored HubSpot token is malformed");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivPart) },
    await encryptionKey(),
    base64ToBytes(ciphertextPart),
  );
  return new TextDecoder().decode(plaintext);
}
