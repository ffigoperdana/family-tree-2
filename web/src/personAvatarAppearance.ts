import type { Gender } from "./types";
import type { UiTheme } from "./uiTheme";

type AvatarAppearance = { fill: string; stroke: string };

const LIGHT_APPEARANCE: Record<Gender, AvatarAppearance> = {
  female: { fill: "#f4e4e8", stroke: "#985c6d" },
  male: { fill: "#e2ebf2", stroke: "#56738d" },
  unspecified: { fill: "#ede5d8", stroke: "#796f63" }
};

const DARK_APPEARANCE: Record<Gender, AvatarAppearance> = {
  female: { fill: "#173549", stroke: "#ed9da7" },
  male: { fill: "#123d5a", stroke: "#9cdef2" },
  unspecified: { fill: "#0e3048", stroke: "#bfc8cb" }
};

export const personAvatarAppearance = (
  gender: Gender,
  theme: UiTheme = "light"
): AvatarAppearance => (theme === "dark" ? DARK_APPEARANCE : LIGHT_APPEARANCE)[gender];
