import { describe, expect, it } from "vitest";
import { searchKnowledgeBase } from "../src/agent/knowledgeBase.js";

describe("searchKnowledgeBase", () => {
  it("finds relevant articles in French and English", () => {
    expect(searchKnowledgeBase("frais virement international")[0]?.id).toBe("kb_transfers");
    expect(searchKnowledgeBase("stolen card")[0]?.id).toBe("kb_lost_stolen_card");
  });

  it("returns nothing for unrelated queries", () => {
    expect(searchKnowledgeBase("zzzz qqqq")).toEqual([]);
  });
});
