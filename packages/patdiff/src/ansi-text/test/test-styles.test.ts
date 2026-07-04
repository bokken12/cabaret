import { describe, expect, it } from "vitest";
import * as Attr from "../attr.js";
import * as Color from "../color.js";
import * as Style from "../style.js";

const testDelta = (oldStyle: Style.T, addedStyle: Style.T): string =>
  Style.toStringHum(Style.delta(oldStyle, addedStyle));

describe("simple deltas", () => {
  const bold: Style.T = [Attr.Bold];
  const red: Style.T = [Attr.Fg(Color.Standard("Red"))];
  const green: Style.T = [Attr.Fg(Color.Standard("Green"))];
  const empty: Style.T = [];
  const off: Style.T = [Attr.Reset];

  it("matches expected outputs", () => {
    expect(testDelta(bold, empty)).toMatchInlineSnapshot(`""`);
    expect(testDelta(empty, bold)).toMatchInlineSnapshot(`"(+bold)"`);
    expect(testDelta(bold, bold)).toMatchInlineSnapshot(`""`);
    expect(testDelta(bold, off)).toMatchInlineSnapshot(`"(off)"`);
    expect(testDelta(off, bold)).toMatchInlineSnapshot(`"(+bold)"`);
    expect(testDelta(bold, red)).toMatchInlineSnapshot(`"(fg:red)"`);
    expect(testDelta(red, bold)).toMatchInlineSnapshot(`"(+bold)"`);
    expect(testDelta(red, green)).toMatchInlineSnapshot(`"(fg:green)"`);
    expect(testDelta(green, red)).toMatchInlineSnapshot(`"(fg:red)"`);
  });
});

describe("both styles have resets", () => {
  it("matches", () => {
    expect(
      testDelta(
        [Attr.Underline, Attr.Reset, Attr.Fg(Color.Standard("Red")), Attr.Bg(Color.Standard("Green")), Attr.Italic],
        [Attr.Reset, Attr.Italic, Attr.Underline],
      ),
    ).toMatchInlineSnapshot(`"(off +italic +uline)"`);
    expect(
      testDelta(
        [Attr.Underline, Attr.Fg(Color.Standard("Red")), Attr.Reset, Attr.Bg(Color.Standard("Green")), Attr.Italic],
        [Attr.Reset, Attr.Italic, Attr.Underline],
      ),
    ).toMatchInlineSnapshot(`"(bg:default +uline)"`);
  });
});

describe("reset in the second style", () => {
  it("matches", () => {
    expect(
      testDelta(
        [Attr.Bold, Attr.Underline, Attr.Fg(Color.Standard("Red")), Attr.Bg(Color.Standard("Green"))],
        [Attr.Blink, Attr.Reset, Attr.Italic, Attr.Underline],
      ),
    ).toMatchInlineSnapshot(`"(off +italic +uline)"`);
  });
});

describe("reset in the first style", () => {
  it("matches", () => {
    expect(
      testDelta(
        [Attr.Bold, Attr.Underline, Attr.Reset, Attr.Italic, Attr.Fg(Color.Standard("Red"))],
        [Attr.Blink, Attr.Italic, Attr.Underline],
      ),
    ).toMatchInlineSnapshot(`"(+blink +uline)"`);
  });
});

describe("no resets", () => {
  it("matches", () => {
    expect(
      testDelta(
        [Attr.Bold, Attr.Underline, Attr.Italic, Attr.Fg(Color.Standard("Red"))],
        [Attr.Blink, Attr.Italic, Attr.Underline, Attr.Bg(Color.Default)],
      ),
    ).toMatchInlineSnapshot(`"(+blink bg:default)"`);
  });
});
