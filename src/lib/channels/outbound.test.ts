import { describe, expect, it } from "vitest";
import { pickChannel } from "./outbound";

const evo = (configured: boolean, isDefault: boolean) => ({ configured, isDefault });

describe("pickChannel", () => {
  it("honours an explicit channel", () => {
    expect(pickChannel({ requested: "meta", conversationChannel: "evolution", evolution: evo(true, true) })).toBe("meta");
    expect(pickChannel({ requested: "evolution", evolution: evo(true, false) })).toBe("evolution");
  });
  it("outreach uses the account default", () => {
    expect(pickChannel({ requested: "default", conversationChannel: "meta", evolution: evo(true, true) })).toBe("evolution");
    expect(pickChannel({ requested: "default", conversationChannel: "evolution", evolution: evo(true, false) })).toBe("meta");
    expect(pickChannel({ requested: "default", evolution: evo(false, true) })).toBe("meta");
  });
  it("replies stay on the chat's number", () => {
    expect(pickChannel({ conversationChannel: "meta", evolution: evo(true, true) })).toBe("meta");
    expect(pickChannel({ conversationChannel: "evolution", evolution: evo(true, false) })).toBe("evolution");
  });
  it("a chat on a removed Evolution setup falls back to Meta", () => {
    expect(pickChannel({ conversationChannel: "evolution", evolution: evo(false, false) })).toBe("meta");
  });
  it("a chat with no channel yet uses the default", () => {
    expect(pickChannel({ conversationChannel: null, evolution: evo(true, true) })).toBe("evolution");
    expect(pickChannel({ conversationChannel: null, evolution: evo(true, false) })).toBe("meta");
  });
});
