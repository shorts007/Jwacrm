import { describe, expect, it } from "vitest";
import type { MessageTemplate } from "@/types";
import { interactiveReplyOptions, matchReplyOption, normalizeDigits, renderInteractive, renderTemplate, templateReplyOptions } from "./render";

const tpl = (over: Partial<MessageTemplate>): MessageTemplate => ({
  id: "t",
  user_id: "u",
  name: "lulu_second_order",
  category: "Marketing",
  body_text: "Hi {{1}}, your 2nd order gets {{2}} off.",
  created_at: "2026-01-01",
  ...over,
});

describe("renderTemplate", () => {
  it("fills body variables and lists quick replies as numbered options", () => {
    const r = renderTemplate(
      tpl({ footer_text: "Reply STOP to opt out", buttons: [{ type: "QUICK_REPLY", text: "English" }, { type: "QUICK_REPLY", text: "العربية" }] }),
      { body: ["Samia", "10%"] },
    );
    expect(r.media).toBeUndefined();
    expect(r.text).toBe("Hi Samia, your 2nd order gets 10% off.\n\n_Reply STOP to opt out_\n\n1️⃣ English\n2️⃣ العربية");
  });

  it("uses legacy positional params when no structured body is given", () => {
    expect(renderTemplate(tpl({}), undefined, ["Ali", "5 SAR"]).text).toBe("Hi Ali, your 2nd order gets 5 SAR off.");
  });

  it("sends an image header as media with the text as caption, preferring the per-send image", () => {
    const r = renderTemplate(tpl({ header_type: "image", header_media_url: "https://x/sample.jpg" }), { body: ["A", "B"], headerMediaUrl: "https://x/promo.jpg" });
    expect(r.media).toEqual({ kind: "image", url: "https://x/promo.jpg" });
    expect(r.text).toBe("Hi A, your 2nd order gets B off.");
  });

  it("renders text headers bold and URL / phone / copy-code buttons as lines", () => {
    const r = renderTemplate(
      tpl({
        header_type: "text",
        header_content: "Offer for {{1}}",
        buttons: [
          { type: "URL", text: "Shop", url: "https://lulu.example/p/{{1}}", example: "x" },
          { type: "PHONE_NUMBER", text: "Call us", phone_number: "+966500000000" },
          { type: "COPY_CODE", text: "Code", example: "SAVE10" },
        ],
      }),
      { body: ["A", "B"], headerText: "you", buttonParams: { 0: "abc" } },
    );
    expect(r.text).toBe(
      "*Offer for you*\n\nHi A, your 2nd order gets B off.\n\n🔗 Shop: https://lulu.example/p/abc\n📞 Call us: +966500000000\n🏷️ Code: SAVE10",
    );
  });

  it("refuses a template with no local copy", () => {
    expect(() => renderTemplate(null, undefined)).toThrow(/sync from Meta/);
  });
});

describe("renderInteractive", () => {
  it("numbers reply buttons", () => {
    expect(renderInteractive({ kind: "buttons", body: "Pick", footer: "f", buttons: [{ id: "a", title: "Yes" }, { id: "b", title: "No" }] })).toBe(
      "Pick\n\n_f_\n\n1️⃣ Yes\n2️⃣ No",
    );
  });
  it("numbers list rows continuously across sections", () => {
    const text = renderInteractive({
      kind: "list",
      body: "Choose",
      button_label: "Open",
      sections: [
        { title: "Fruit", rows: [{ id: "1", title: "Apple" }] },
        { title: "Veg", rows: [{ id: "2", title: "Leek", description: "fresh" }] },
      ],
    });
    expect(text).toBe("Choose\n\n*Fruit*\n1️⃣ Apple\n\n*Veg*\n2️⃣ Leek — fresh");
  });
});

describe("matchReplyOption", () => {
  const options = templateReplyOptions(tpl({ buttons: [{ type: "QUICK_REPLY", text: "English" }, { type: "QUICK_REPLY", text: "العربية" }] }));
  it("accepts the number in any form", () => {
    for (const input of ["2", " 2. ", "2️⃣", "٢", "۲"]) expect(matchReplyOption(input, options)?.id).toBe("العربية");
  });
  it("accepts the option text, ignoring case and punctuation", () => {
    expect(matchReplyOption("english!", options)?.id).toBe("English");
    expect(matchReplyOption("العربية", options)?.id).toBe("العربية");
  });
  it("returns null for anything else", () => {
    expect(matchReplyOption("3", options)).toBeNull();
    expect(matchReplyOption("I want english please", options)).toBeNull();
    expect(matchReplyOption("1", [])).toBeNull();
  });
  it("maps interactive ids, not titles", () => {
    const o = interactiveReplyOptions({ kind: "buttons", body: "b", buttons: [{ id: "opt_yes", title: "Yes" }] });
    expect(matchReplyOption("1", o)?.id).toBe("opt_yes");
  });
  it("normalizes digits", () => {
    expect(normalizeDigits("١٢ 3️⃣ 🔟")).toBe("12 3 10");
  });
});
