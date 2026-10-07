import { describe, expect, it } from "vitest";
import { jidDigits, normalizeBaseUrl } from "./client";
import { redactPayload } from "./server";

describe("evolution helpers", () => {
  it("normalises the server address", () => {
    expect(normalizeBaseUrl(" https://evo.example.com/ ")).toBe("https://evo.example.com");
    expect(normalizeBaseUrl("http://129.159.20.81:8080")).toBe("http://129.159.20.81:8080");
    expect(normalizeBaseUrl("ftp://x")).toBeNull();
    expect(normalizeBaseUrl("not a url")).toBeNull();
  });
  it("extracts digits from JIDs", () => {
    expect(jidDigits("966501234567@s.whatsapp.net")).toBe("966501234567");
    expect(jidDigits("966501234567:12@s.whatsapp.net")).toBe("966501234567");
    expect(jidDigits(null)).toBe("");
  });
  it("redacts secrets and inline media before logging", () => {
    const r = redactPayload({ apikey: "secret", data: { message: { imageMessage: { jpegThumbnail: "x" } }, base64: "a".repeat(5000) } }) as { apikey: string; data: { base64: string; message: { imageMessage: { jpegThumbnail: string } } } };
    expect(r.apikey).toBe("[redacted]");
    expect(r.data.message.imageMessage.jpegThumbnail).toBe("[redacted]");
    expect(r.data.base64).toBe("[5000 chars]");
  });
});
