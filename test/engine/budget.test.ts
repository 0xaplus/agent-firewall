import { describe, expect, test } from "bun:test";
import { budgetNotice } from "../../src/budget";

describe("budgetNotice", () => {
  test("below 80%: no notice", () => {
    expect(budgetNotice(0, 2500)).toEqual({ pct: 0, level: "ok", text: null });
    expect(budgetNotice(1999.99, 2500)).toEqual({ pct: 79, level: "ok", text: null });
  });
  test("from 80%: a warning with the percentage, rounded down", () => {
    expect(budgetNotice(2000, 2500)).toEqual({ pct: 80, level: "warn", text: "80% of monthly budget used" });
    expect(budgetNotice(2050, 2500)).toEqual({ pct: 82, level: "warn", text: "82% of monthly budget used" });
    expect(budgetNotice(2499.99, 2500)).toMatchObject({ pct: 99, level: "warn" });
  });
  test("at or over 100%: used up", () => {
    expect(budgetNotice(2500, 2500)).toEqual({ pct: 100, level: "full", text: "Monthly budget used up" });
    expect(budgetNotice(2600, 2500)).toMatchObject({ pct: 104, level: "full", text: "Monthly budget used up" });
  });
  test("a zero or invalid cap gives no notice", () => {
    expect(budgetNotice(10, 0).level).toBe("ok");
    expect(budgetNotice(10, Number.NaN).level).toBe("ok");
  });
});
