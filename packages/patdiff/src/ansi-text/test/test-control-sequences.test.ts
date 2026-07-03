import { describe, expect, it } from "vitest";
import * as Control from "../control.js";

describe("of_csi_params |> to_string round-trips", () => {
  it("matches", () => {
    expect(Control.toString(Control.ofCsiParams([], "A"))).toMatchInlineSnapshot(`"[A"`);
    expect(Control.toString(Control.ofCsiParams([1], "B"))).toMatchInlineSnapshot(`"[1B"`);
    expect(Control.toString(Control.ofCsiParams([], "H"))).toMatchInlineSnapshot(`"[H"`);
    expect(Control.toString(Control.ofCsiParams([undefined, undefined], "H"))).toMatchInlineSnapshot(`"[H"`);
    expect(Control.toString(Control.ofCsiParams([undefined, 2], "H"))).toMatchInlineSnapshot(`"[;2H"`);
    expect(Control.toString(Control.ofCsiParams([3, 4], "H"))).toMatchInlineSnapshot(`"[3;4H"`);
  });
});

describe("visualization with to_string_hum", () => {
  it("matches", () => {
    expect(Control.toStringHum(Control.ofCsiParams([], "E"))).toMatchInlineSnapshot(`"(CursorNextLine)"`);
    expect(Control.toStringHum(Control.ofCsiParams([], "K"))).toMatchInlineSnapshot(`"(EraseLine:ToEnd)"`);
    expect(Control.toStringHum(Control.ofCsiParams([12], "C"))).toMatchInlineSnapshot(`"(CursorForward:12)"`);
    expect(Control.toStringHum(Control.ofCsiParams([1, 2], "H"))).toMatchInlineSnapshot(`"(CursorToPos:1;2)"`);
  });
});
