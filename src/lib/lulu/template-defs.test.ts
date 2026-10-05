import { describe, expect, it } from "vitest";
import { validateTemplatePayload } from "@/lib/whatsapp/template-validators";
import { DEFAULT_TEMPLATE_NAMES, LULU_TEMPLATE_DEFS } from "./index";

describe("LULU_TEMPLATE_DEFS", () => {
  it("every template passes WACRM's own Meta-rule validator", () => {
    for (const d of LULU_TEMPLATE_DEFS) expect(() => validateTemplatePayload(d), d.name).not.toThrow();
  });
  it("has an EN and AR template for each default campaign name", () => {
    const names = new Set(LULU_TEMPLATE_DEFS.map((d) => d.name));
    for (const pair of Object.values(DEFAULT_TEMPLATE_NAMES)) {
      expect(names.has(pair!.ar)).toBe(true);
      expect(names.has(pair!.en)).toBe(true);
    }
  });
  it("sample value count matches the variable count", () => {
    for (const d of LULU_TEMPLATE_DEFS) {
      const vars = new Set([...d.body_text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
      expect(d.sample_values?.body?.length, d.name).toBe(vars);
    }
  });
});
