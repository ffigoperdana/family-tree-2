import { describe, expect, it } from "vitest";

import { personAvatarAppearance } from "./personAvatarAppearance";

describe("person avatar appearance", () => {
  it("uses distinct fill and border colors for every gender", () => {
    const appearances = [
      personAvatarAppearance("female"),
      personAvatarAppearance("male"),
      personAvatarAppearance("unspecified")
    ];

    expect(new Set(appearances.map(({ fill }) => fill)).size).toBe(3);
    expect(new Set(appearances.map(({ stroke }) => stroke)).size).toBe(3);
  });

  it("uses navy fills with bright outlines in dark mode", () => {
    const unspecified = personAvatarAppearance("unspecified", "dark");
    const male = personAvatarAppearance("male", "dark");

    expect(unspecified.fill).toBe("#0e3048");
    expect(unspecified.stroke).toBe("#bfc8cb");
    expect(male.fill).toBe("#123d5a");
    expect(male.stroke).toBe("#9cdef2");
  });
});
