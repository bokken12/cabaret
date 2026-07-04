import { describe, expect, it } from "vitest";
import { Percent } from "../shared/index.js";
import type { DiffInput } from "./diff-input.js";
import * as Format from "./format.js";
import { withoutUnix } from "./patdiff-core.js";

const patdiff = withoutUnix.patdiff;

describe("test_patdiff_core (default)", () => {
  const prev: DiffInput = { name: "old", text: "Foo bar buzz" };
  const next: DiffInput = { name: "old", text: "Foo buzz" };

  it("Ansi output generates a single line diff", () => {
    expect(
      patdiff({
        splitLongLines: false,
        produceUnifiedLines: true,
        output: "Ansi",
        prev,
        next,
      }),
    ).toMatchInlineSnapshot(`
      "-1,1 +1,1
      [1;33m!|[22;39mFoo[31m bar[39m buzz"
    `);
  });

  it("Ascii is supported if [produce_unified_lines] is false", () => {
    expect(
      patdiff({
        splitLongLines: false,
        produceUnifiedLines: false,
        output: "Ascii",
        prev,
        next,
      }),
    ).toMatchInlineSnapshot(`
      "-1,1 +1,1
      -|Foo bar buzz
      +|Foo buzz"
    `);
  });

  it("don't highlight empty newlines (ascii)", () => {
    expect(
      patdiff({
        keepWs: true,
        splitLongLines: false,
        produceUnifiedLines: false,
        output: "Ascii",
        prev: { name: "old", text: "" },
        next: { name: "new", text: "\n\n\n" },
      }),
    ).toMatchInlineSnapshot(`
      "-1,0 +1,3
      +|
      +|
      +|"
    `);
  });

  it("don't highlight empty newlines (ansi)", () => {
    expect(
      patdiff({
        keepWs: true,
        splitLongLines: false,
        produceUnifiedLines: false,
        output: "Ansi",
        prev: { name: "old", text: "" },
        next: { name: "new", text: "\n\n\n" },
      }),
    ).toMatchInlineSnapshot(`
      "-1,0 +1,3
      [1;32m+|[22;39m[32m[39m
      [1;32m+|[22;39m[32m[39m
      [1;32m+|[22;39m[32m[39m"
    `);
  });

  it("do highlight empty newlines with some spaces (ansi)", () => {
    expect(
      patdiff({
        keepWs: true,
        splitLongLines: false,
        produceUnifiedLines: false,
        output: "Ansi",
        prev: { name: "old", text: "" },
        next: { name: "new", text: "  \n  \n  \n" },
      }),
    ).toMatchInlineSnapshot(`
      "-1,0 +1,3
      [1;32m+|[22;39m[7;32m  [27;39m
      [1;32m+|[22;39m[7;32m  [27;39m
      [1;32m+|[22;39m[7;32m  [27;39m"
    `);
  });

  it("Ascii is not supported if [produce_unified_lines] is true", () => {
    expect(() =>
      patdiff({
        splitLongLines: false,
        produceUnifiedLines: true,
        output: "Ascii",
        prev,
        next,
      }),
    ).toThrow();
  });

  it("float tolerance works as expected", () => {
    const cases: ReadonlyArray<readonly [Percent | undefined, string, string]> = [
      [undefined, "1.0", "1.00000000000001"],
      [undefined, "1.0", "1.0"],
      [Percent.ofMult(0.01), "1.0", "1.005"],
      [Percent.ofMult(0.01), "1.0", "1.015"],
    ];
    // Cosmetic drift: OCaml uses [List.iter ... print_endline] so the two
    // no-diff iterations contribute one blank line each between the two real
    // diffs (total: 2 blank lines). Joining with "\n\n" here gives 4 blank
    // lines. Diff *content* matches OCaml byte-for-byte; only the
    // inter-iteration spacing differs.
    const outputs = cases.map(([floatTolerance, oldText, newText]) =>
      patdiff({
        ...(floatTolerance !== undefined ? { floatTolerance } : {}),
        produceUnifiedLines: false,
        output: "Ascii",
        prev: { name: "old", text: oldText },
        next: { name: "new", text: newText },
      }),
    );
    expect(outputs.join("\n\n")).toMatchInlineSnapshot(`
      "-1,1 +1,1
      -|1.0
      +|1.00000000000001





      -1,1 +1,1
      -|1.0
      +|1.015"
    `);
  });

  it("test single empty line", () => {
    const original = `Line one
Some line that will be deleted (and replaced with a single newline)
  with some indented content on the next line
Line four
Line five
Line six
`;
    const modified = `Line one

Line four
Line five
An added line goes here
Line six`;
    expect(
      patdiff({
        produceUnifiedLines: false,
        output: "Ascii",
        prev: { name: "old", text: original },
        next: { name: "new", text: modified },
      }),
    ).toMatchInlineSnapshot(`
      "-1,6 +1,6
        Line one
      -|Some line that will be deleted (and replaced with a single newline)
      -|  with some indented content on the next line
        Line four
        Line five
      +|An added line goes here
        Line six"
    `);
  });
});

describe("test_patdiff_core (python)", () => {
  const prev: DiffInput = { name: "old.py", text: "print(5)" };
  const next: DiffInput = { name: "new.py", text: "if True:\n    print(5)" };
  const noAnsiEscapes = (s: string): boolean => !s.includes("\x1b");

  it("Ansi output generates a single line diff", () => {
    expect(
      patdiff({
        splitLongLines: false,
        produceUnifiedLines: true,
        output: "Ansi",
        prev,
        next,
      }),
    ).toMatchInlineSnapshot(`
      "-1,1 +1,2
      [1;33m!|[22;39m[32mif True:[39m
      [1;33m!|[22;39m[7;32m    [27;39mprint(5)"
    `);
  });

  it("Ascii is supported if [produce_unified_lines] is false", () => {
    expect(
      patdiff({
        splitLongLines: false,
        produceUnifiedLines: false,
        output: "Ascii",
        prev,
        next,
      }),
    ).toMatchInlineSnapshot(`
      "-1,1 +1,2
      -|print(5)
      +|if True:
      +|    print(5)"
    `);
  });

  it("Ascii output does not contain ANSI escapes", () => {
    expect(noAnsiEscapes(patdiff({ output: "Ascii", produceUnifiedLines: false, prev, next }))).toBe(true);
  });

  it("Ascii output with keepWs:false does not contain ANSI escapes", () => {
    expect(
      noAnsiEscapes(
        patdiff({
          output: "Ascii",
          produceUnifiedLines: false,
          keepWs: false,
          prev,
          next,
        }),
      ),
    ).toBe(true);
  });

  it("Ascii output with keepWs:true does not contain ANSI escapes", () => {
    expect(
      noAnsiEscapes(
        patdiff({
          output: "Ascii",
          produceUnifiedLines: false,
          keepWs: true,
          prev,
          next,
        }),
      ),
    ).toBe(true);
  });

  it("Ascii output with stripped styles does not contain ANSI escapes", () => {
    expect(
      noAnsiEscapes(
        patdiff({
          output: "Ascii",
          produceUnifiedLines: false,
          rules: Format.Rules.stripStyles(Format.Rules.defaultRules),
          prev,
          next,
        }),
      ),
    ).toBe(true);
  });

  const testMoves = (prevText: string, nextText: string): string => {
    const prevInput: DiffInput = { name: "old", text: prevText };
    const nextInput: DiffInput = { name: "new", text: nextText };
    const baseRules = Format.Rules.defaultRules;
    const removedInMove = Format.Rule.create([], {
      pre: Format.Affix.create(">-"),
    });
    const addedInMove = Format.Rule.create([], {
      pre: Format.Affix.create(">+"),
    });
    const lineUnifiedInMove = Format.Rule.create([], {
      pre: Format.Affix.create(">!"),
    });
    const rules: Format.Rules = {
      ...baseRules,
      removedInMove,
      addedInMove,
      lineUnifiedInMove,
    };
    return patdiff({
      rules,
      findMoves: true,
      prev: prevInput,
      next: nextInput,
      output: "Ascii",
      produceUnifiedLines: false,
    });
  };

  it("test a simple move", () => {
    const prev = `
Lorem ipsum dolor sit amet, consectetur adipiscing elit. Fusce sit amet
malesuada leo. Vivamus vitae orci quis justo ornare molestie. Donec fringilla
tempus magna, ut semper lacus tincidunt at. Suspendisse et rutrum arcu. Aliquam
erat volutpat. Pellentesque pretium pellentesque elit, a consequat metus
placerat a. Praesent hendrerit euismod sem nec facilisis. Curabitur finibus ex
sagittis massa blandit, et dictum lectus lobortis. Sed fringilla fringilla
tortor vel finibus. Sed vel tortor pulvinar, fermentum quam non, blandit lorem.

Maecenas ac elit turpis. Nam ex turpis, ullamcorper et ultricies eu, pretium et
elit. Duis bibendum aliquet quam et tempor. Donec quis dapibus justo. Praesent
eget pellentesque nisi. Nulla vestibulum orci quis dui laoreet, eget posuere sem
interdum. Morbi ac sodales ligula. Proin arcu ipsum, venenatis id cursus et,
blandit eu mi. Sed iaculis egestas ligula, lacinia condimentum velit commodo
non. In eu elit convallis, tempus sapien sed, maximus purus. Sed vitae enim et
tellus accumsan bibendum eu vel turpis. Phasellus massa leo, eleifend vel
tincidunt ut, consequat et est. Duis quis condimentum ex. Etiam nec faucibus
lorem. Aliquam vehicula porta sapien, ut aliquam purus cursus vitae. Nullam at
ex vehicula, egestas sapien vitae, molestie ipsum.

Suspendisse iaculis lacinia arcu a vehicula. Nunc eleifend fermentum iaculis.
Duis dignissim, mi sit amet vehicula auctor, odio mauris consectetur lectus, ac
tincidunt lorem diam a nisi. Duis vehicula ex ac tortor sagittis, ac commodo
lectus venenatis. Nam efficitur justo eros, et ornare neque aliquet ut. Duis
vulputate nulla nunc, eget pellentesque diam aliquam at. Cras rhoncus orci at
tortor posuere convallis sed sed risus. Quisque sed ipsum ex.

Cras non semper ante. Vivamus non nulla scelerisque, fermentum sem at, laoreet
est. Sed convallis, magna sit amet maximus sollicitudin, nulla metus sodales
eros, eu molestie arcu urna ut nunc. Pellentesque habitant morbi tristique
senectus et netus et malesuada fames ac turpis egestas. Morbi sollicitudin,
turpis sit amet ultricies interdum, urna nisl rhoncus tellus, id consectetur
urna risus ut arcu. Aliquam hendrerit eros id ex tempor vehicula. Nunc a pretium
risus. Nulla tincidunt, mauris eu pellentesque hendrerit, nisi nibh volutpat
sapien, vitae vehicula lacus tellus dictum augue. Pellentesque malesuada vitae
tellus lobortis laoreet. Donec fringilla lacinia nulla sit amet eleifend.
Suspendisse iaculis metus sed massa bibendum, quis consequat metus lacinia.
Etiam scelerisque odio nec pulvinar dapibus. Duis interdum interdum quam vel
dapibus. Quisque dapibus nisl quis magna accumsan, et lobortis magna eleifend.
Ut venenatis cursus diam, vel dictum augue interdum vitae. Ut scelerisque
condimentum augue, eget bibendum augue lacinia in.

Aenean porta elit vitae pharetra dapibus. Duis a odio neque. Curabitur
ullamcorper enim ut metus luctus, eu blandit augue consectetur. Vestibulum
blandit lorem eget blandit fringilla. In et libero non lacus elementum pulvinar
id a orci. Maecenas porta urna mollis, egestas lacus id, feugiat nisi. Vivamus
imperdiet ornare dui eleifend semper. Integer erat ipsum, vestibulum a lobortis
eu, posuere in orci. Pellentesque gravida in purus eu ullamcorper. Nunc urna
tortor, hendrerit nec eleifend et, dapibus sed dolor.
`;
    const next = `
Lorem ipsum dolor sit amet, consectetur adipiscing elit. Fusce sit amet
malesuada leo. Vivamus vitae orci quis justo ornare molestie. Donec fringilla
tempus magna, ut semper lacus tincidunt at. Suspendisse et rutrum arcu. Aliquam
erat volutpat. Pellentesque pretium pellentesque elit, a consequat metus
placerat a. Praesent hendrerit euismod sem nec facilisis. Curabitur finibus ex
sagittis massa blandit, et dictum lectus lobortis. Sed fringilla fringilla
tortor vel finibus. Sed vel tortor pulvinar, fermentum quam non, blandit lorem.

Maecenas ac elit turpis. Nam ex turpis, ullamcorper et ultricies eu, pretium et
elit. Duis bibendum aliquet quam et tempor. Donec quis dapibus justo. Praesent
eget pellentesque nisi. Nulla vestibulum orci quis dui laoreet, eget posuere sem
interdum. Morbi ac sodales ligula. Proin arcu ipsum, venenatis id cursus et,
blandit eu mi. Sed iaculis egestas ligula, lacinia condimentum velit commodo
non. In eu elit convallis, tempus sapien sed, maximus purus. Sed vitae enim et
tellus accumsan bibendum eu vel turpis. Phasellus massa leo, eleifend vel
tincidunt ut, consequat et est. Duis quis condimentum ex. Etiam nec faucibus
lorem. Aliquam vehicula porta sapien, ut aliquam purus cursus vitae. Nullam at
ex vehicula, egestas sapien vitae, molestie ipsum.

Cras non semper ante. Vivamus non nulla scelerisque, fermentum sem at, laoreet
est. Sed convallis, magna sit amet maximus sollicitudin, nulla metus sodales
eros, eu molestie arcu urna ut nunc. Pellentesque habitant morbi tristique
senectus et netus et malesuada fames ac turpis egestas. Morbi sollicitudin,
turpis sit amet ultricies interdum, urna nisl rhoncus tellus, id consectetur
urna risus ut arcu. Aliquam hendrerit eros id ex tempor vehicula. Nunc a pretium
risus. Nulla tincidunt, mauris eu pellentesque hendrerit, nisi nibh volutpat
sapien, vitae vehicula lacus tellus dictum augue. Pellentesque malesuada vitae
tellus lobortis laoreet. Donec fringilla lacinia nulla sit amet eleifend.
Suspendisse iaculis metus sed massa bibendum, quis consequat metus lacinia.
Etiam scelerisque odio nec pulvinar dapibus. Duis interdum interdum quam vel
dapibus. Quisque dapibus nisl quis magna accumsan, et lobortis magna eleifend.
Ut venenatis cursus diam, vel dictum augue interdum vitae. Ut scelerisque
condimentum augue, eget bibendum augue lacinia in.

Suspendisse iaculis lacinia arcu a vehicula. Nunc eleifend fermentum iaculis.
Duis dignissim, mi sit amet vehicula auctor, odio mauris consectetur lectus, ac
tincidunt lorem diam a nisi. Duis vehicula ex ac tortor sagittis, ac commodo
lectus venenatis. Nam efficitur justo eros, et ornare neque aliquet ut. Duis
vulputate nulla nunc, eget pellentesque diam aliquam at. Cras rhoncus orci at
tortor posuere convallis sed sed risus. Quisque sed ipsum ex.

Aenean porta elit vitae pharetra dapibus. Duis a odio neque. Curabitur
ullamcorper enim ut metus luctus, eu blandit augue consectetur. Vestibulum
blandit lorem eget blandit fringilla. In et libero non lacus elementum pulvinar
id a orci. Maecenas porta urna mollis, egestas lacus id, feugiat nisi. Vivamus
imperdiet ornare dui eleifend semper. Integer erat ipsum, vestibulum a lobortis
eu, posuere in orci. Pellentesque gravida in purus eu ullamcorper. Nunc urna
tortor, hendrerit nec eleifend et, dapibus sed dolor.
`;
    expect(testMoves(prev, next)).toMatchInlineSnapshot(`
      "-4,46 +4,46
        tempus magna, ut semper lacus tincidunt at. Suspendisse et rutrum arcu. Aliquam
        erat volutpat. Pellentesque pretium pellentesque elit, a consequat metus
        placerat a. Praesent hendrerit euismod sem nec facilisis. Curabitur finibus ex
        sagittis massa blandit, et dictum lectus lobortis. Sed fringilla fringilla
        tortor vel finibus. Sed vel tortor pulvinar, fermentum quam non, blandit lorem.
        
        Maecenas ac elit turpis. Nam ex turpis, ullamcorper et ultricies eu, pretium et
        elit. Duis bibendum aliquet quam et tempor. Donec quis dapibus justo. Praesent
        eget pellentesque nisi. Nulla vestibulum orci quis dui laoreet, eget posuere sem
        interdum. Morbi ac sodales ligula. Proin arcu ipsum, venenatis id cursus et,
        blandit eu mi. Sed iaculis egestas ligula, lacinia condimentum velit commodo
        non. In eu elit convallis, tempus sapien sed, maximus purus. Sed vitae enim et
        tellus accumsan bibendum eu vel turpis. Phasellus massa leo, eleifend vel
        tincidunt ut, consequat et est. Duis quis condimentum ex. Etiam nec faucibus
        lorem. Aliquam vehicula porta sapien, ut aliquam purus cursus vitae. Nullam at
        ex vehicula, egestas sapien vitae, molestie ipsum.
      <|
      <|Suspendisse iaculis lacinia arcu a vehicula. Nunc eleifend fermentum iaculis.
      <|Duis dignissim, mi sit amet vehicula auctor, odio mauris consectetur lectus, ac
      <|tincidunt lorem diam a nisi. Duis vehicula ex ac tortor sagittis, ac commodo
      <|lectus venenatis. Nam efficitur justo eros, et ornare neque aliquet ut. Duis
      <|vulputate nulla nunc, eget pellentesque diam aliquam at. Cras rhoncus orci at
      <|tortor posuere convallis sed sed risus. Quisque sed ipsum ex.
        
        Cras non semper ante. Vivamus non nulla scelerisque, fermentum sem at, laoreet
        est. Sed convallis, magna sit amet maximus sollicitudin, nulla metus sodales
        eros, eu molestie arcu urna ut nunc. Pellentesque habitant morbi tristique
        senectus et netus et malesuada fames ac turpis egestas. Morbi sollicitudin,
        turpis sit amet ultricies interdum, urna nisl rhoncus tellus, id consectetur
        urna risus ut arcu. Aliquam hendrerit eros id ex tempor vehicula. Nunc a pretium
        risus. Nulla tincidunt, mauris eu pellentesque hendrerit, nisi nibh volutpat
        sapien, vitae vehicula lacus tellus dictum augue. Pellentesque malesuada vitae
        tellus lobortis laoreet. Donec fringilla lacinia nulla sit amet eleifend.
        Suspendisse iaculis metus sed massa bibendum, quis consequat metus lacinia.
        Etiam scelerisque odio nec pulvinar dapibus. Duis interdum interdum quam vel
        dapibus. Quisque dapibus nisl quis magna accumsan, et lobortis magna eleifend.
        Ut venenatis cursus diam, vel dictum augue interdum vitae. Ut scelerisque
        condimentum augue, eget bibendum augue lacinia in.
      >|
      >|Suspendisse iaculis lacinia arcu a vehicula. Nunc eleifend fermentum iaculis.
      >|Duis dignissim, mi sit amet vehicula auctor, odio mauris consectetur lectus, ac
      >|tincidunt lorem diam a nisi. Duis vehicula ex ac tortor sagittis, ac commodo
      >|lectus venenatis. Nam efficitur justo eros, et ornare neque aliquet ut. Duis
      >|vulputate nulla nunc, eget pellentesque diam aliquam at. Cras rhoncus orci at
      >|tortor posuere convallis sed sed risus. Quisque sed ipsum ex.
        
        Aenean porta elit vitae pharetra dapibus. Duis a odio neque. Curabitur
        ullamcorper enim ut metus luctus, eu blandit augue consectetur. Vestibulum
        blandit lorem eget blandit fringilla. In et libero non lacus elementum pulvinar
        id a orci. Maecenas porta urna mollis, egestas lacus id, feugiat nisi. Vivamus
        imperdiet ornare dui eleifend semper. Integer erat ipsum, vestibulum a lobortis
        eu, posuere in orci. Pellentesque gravida in purus eu ullamcorper. Nunc urna
        tortor, hendrerit nec eleifend et, dapibus sed dolor."
    `);
  });

  it("test a move with a slight modification", () => {
    const prev = `
Maecenas ac elit turpis. Nam ex turpis, ullamcorper et ultricies eu, pretium et
elit. Duis bibendum aliquet quam et tempor. Donec quis dapibus justo. Praesent
eget pellentesque nisi. Nulla vestibulum orci quis dui laoreet, eget posuere sem
interdum. Morbi ac sodales ligula. Proin arcu ipsum, venenatis id cursus et,
blandit eu mi. Sed iaculis egestas ligula, lacinia condimentum velit commodo
non. In eu elit convallis, tempus sapien sed, maximus purus. Sed vitae enim et
tellus accumsan bibendum eu vel turpis. Phasellus massa leo, eleifend vel
tincidunt ut, consequat et est. Duis quis condimentum ex. Etiam nec faucibus
lorem. Aliquam vehicula porta sapien, ut aliquam purus cursus vitae. Nullam at
ex vehicula, egestas sapien vitae, molestie ipsum.

Suspendisse iaculis lacinia arcu a vehicula. Nunc eleifend fermentum iaculis.
Duis dignissim, mi sit amet vehicula auctor, odio mauris consectetur lectus, ac
tincidunt lorem diam a nisi. Duis vehicula ex ac tortor sagittis, ac commodo
lectus venenatis. Nam efficitur justo eros, et ornare neque aliquet ut. Duis
vulputate nulla nunc, eget pellentesque diam aliquam at. Cras rhoncus orci at
tortor posuere convallis sed sed risus. Quisque sed ipsum ex.

Cras non semper ante. Vivamus non nulla scelerisque, fermentum sem at, laoreet
est. Sed convallis, magna sit amet maximus sollicitudin, nulla metus sodales
eros, eu molestie arcu urna ut nunc. Pellentesque habitant morbi tristique
senectus et netus et malesuada fames ac turpis egestas. Morbi sollicitudin,
turpis sit amet ultricies interdum, urna nisl rhoncus tellus, id consectetur
urna risus ut arcu. Aliquam hendrerit eros id ex tempor vehicula. Nunc a pretium
risus. Nulla tincidunt, mauris eu pellentesque hendrerit, nisi nibh volutpat
sapien, vitae vehicula lacus tellus dictum augue. Pellentesque malesuada vitae
tellus lobortis laoreet. Donec fringilla lacinia nulla sit amet eleifend.
Suspendisse iaculis metus sed massa bibendum, quis consequat metus lacinia.
Etiam scelerisque odio nec pulvinar dapibus. Duis interdum interdum quam vel
dapibus. Quisque dapibus nisl quis magna accumsan, et lobortis magna eleifend.
Ut venenatis cursus diam, vel dictum augue interdum vitae. Ut scelerisque
condimentum augue, eget bibendum augue lacinia in.

Aenean porta elit vitae pharetra dapibus. Duis a odio neque. Curabitur
ullamcorper enim ut metus luctus, eu blandit augue consectetur. Vestibulum
blandit lorem eget blandit fringilla. In et libero non lacus elementum pulvinar
id a orci. Maecenas porta urna mollis, egestas lacus id, feugiat nisi. Vivamus
imperdiet ornare dui eleifend semper. Integer erat ipsum, vestibulum a lobortis
eu, posuere in orci. Pellentesque gravida in purus eu ullamcorper. Nunc urna
tortor, hendrerit nec eleifend et, dapibus sed dolor.

Suspendisse convallis justo vitae leo efficitur ultrices. Fusce ullamcorper nisl
accumsan maximus ultricies. Donec eu orci feugiat, lacinia ipsum a, rhoncus
augue. Nullam mollis, dolor in varius auctor, ex tortor dapibus quam, id
consectetur ipsum nunc ac leo. Maecenas condimentum nunc sed convallis ultrices.
Suspendisse semper hendrerit ante, quis convallis dui eleifend et. Duis dui
risus, laoreet eu suscipit eget, pretium vitae risus. Lorem ipsum dolor sit
amet, consectetur adipiscing elit. Proin bibendum consequat pharetra. Morbi
scelerisque vitae tellus sodales mattis.

Nunc maximus porttitor nulla sit amet porta. Aenean tellus dui, viverra nec
congue vitae, posuere a erat. Vestibulum lectus nibh, gravida et orci at,
gravida eleifend tellus. Vestibulum nec iaculis odio. Donec et dui quis orci
gravida euismod non sed eros. Aliquam ipsum metus, tempus a risus molestie,
maximus vestibulum nibh. Cras sit amet sagittis nunc. Donec bibendum eros
maximus lacus imperdiet, ac mollis quam tristique. Nunc eleifend ullamcorper
tincidunt. Ut ut pulvinar ante. Mauris gravida, arcu vitae suscipit ultrices,
elit metus sagittis odio, at pretium leo leo in odio. Ut dictum mi ac purus
ullamcorper finibus.
`;
    const next = `
Maecenas ac elit turpis. Nam ex turpis, ullamcorper et ultricies eu, pretium et
elit. Duis bibendum aliquet quam et tempor. Donec quis dapibus justo. Praesent
eget pellentesque nisi. Nulla vestibulum orci quis dui laoreet, eget posuere sem
interdum. Morbi ac sodales ligula. Proin arcu ipsum, venenatis id cursus et,
blandit eu mi. Sed iaculis egestas ligula, lacinia condimentum velit commodo
non. In eu elit convallis, tempus sapien sed, maximus purus. Sed vitae enim et
tellus accumsan bibendum eu vel turpis. Phasellus massa leo, eleifend vel
tincidunt ut, consequat et est. Duis quis condimentum ex. Etiam nec faucibus
lorem. Aliquam vehicula porta sapien, ut aliquam purus cursus vitae. Nullam at
ex vehicula, egestas sapien vitae, molestie ipsum.

Cras non semper ante. Vivamus non nulla scelerisque, fermentum sem at, laoreet
est. Sed convallis, magna sit amet maximus sollicitudin, nulla metus sodales
eros, eu molestie arcu urna ut nunc. Pellentesque habitant morbi tristique
senectus et netus et malesuada fames ac turpis egestas. Morbi sollicitudin,
turpis sit amet ultricies interdum, urna nisl rhoncus tellus, id consectetur
urna risus ut arcu. Aliquam hendrerit eros id ex tempor vehicula. Nunc a pretium
risus. Nulla tincidunt, mauris eu pellentesque hendrerit, nisi nibh volutpat
sapien, vitae vehicula lacus tellus dictum augue. Pellentesque malesuada vitae
tellus lobortis laoreet. Donec fringilla lacinia nulla sit amet eleifend.
Suspendisse iaculis metus sed massa bibendum, quis consequat metus lacinia.
Etiam scelerisque odio nec pulvinar dapibus. Duis interdum interdum quam vel
dapibus. Quisque dapibus nisl quis magna accumsan, et lobortis magna eleifend.
Ut venenatis cursus diam, vel dictum augue interdum vitae. Ut scelerisque
condimentum augue, eget bibendum augue lacinia in.

Aenean porta elit vitae pharetra dapibus. Duis a odio neque. Curabitur
ullamcorper enim ut metus luctus, eu blandit augue consectetur. Vestibulum
blandit lorem eget blandit fringilla. In et libero non lacus elementum pulvinar
id a orci. Maecenas porta urna mollis, egestas lacus id, feugiat nisi. Vivamus
imperdiet ornare dui eleifend semper. Integer erat ipsum, vestibulum a lobortis
eu, posuere in orci. Pellentesque gravida in purus eu ullamcorper. Nunc urna
tortor, hendrerit nec eleifend et, dapibus sed dolor.

Suspendisse iaculis lacinia arcu a vehicula. Nunc eleifend fermentum iaculis.
Duis dignissim, mi sit amet vehicula auctor, odio mauris consectetur lectus, ac
tincidunt lorem diam a nisi. Duis vehicula exe ace tortor sagittis, ac commodo
lectus venenatis. Nam efficitur justo eros, et ornare neque aliquet ut. Duis
vulputate nulla nunc, eget pellentesque diam aliquam at. Cras rhoncus orci at
tortor posuere convallis sed sed risus. Quisque sed ipsum ex.

Suspendisse convallis justo vitae leo efficitur ultrices. Fusce ullamcorper nisl
accumsan maximus ultricies. Donec eu orci feugiat, lacinia ipsum a, rhoncus
augue. Nullam mollis, dolor in varius auctor, ex tortor dapibus quam, id
consectetur ipsum nunc ac leo. Maecenas condimentum nunc sed convallis ultrices.
Suspendisse semper hendrerit ante, quis convallis dui eleifend et. Duis dui
risus, laoreet eu suscipit eget, pretium vitae risus. Lorem ipsum dolor sit
amet, consectetur adipiscing elit. Proin bibendum consequat pharetra. Morbi
scelerisque vitae tellus sodales mattis.

Nunc maximus porttitor nulla sit amet porta. Aenean tellus dui, viverra nec
congue vitae, posuere a erat. Vestibulum lectus nibh, gravida et orci at,
gravida eleifend tellus. Vestibulum nec iaculis odio. Donec et dui quis orci
gravida euismod non sed eros. Aliquam ipsum metus, tempus a risus molestie,
maximus vestibulum nibh. Cras sit amet sagittis nunc. Donec bibendum eros
maximus lacus imperdiet, ac mollis quam tristique. Nunc eleifend ullamcorper
tincidunt. Ut ut pulvinar ante. Mauris gravida, arcu vitae suscipit ultrices,
elit metus sagittis odio, at pretium leo leo in odio. Ut dictum mi ac purus
ullamcorper finibus.
`;
    expect(testMoves(prev, next)).toMatchInlineSnapshot(`
      "-1,57 +1,57
        
        Maecenas ac elit turpis. Nam ex turpis, ullamcorper et ultricies eu, pretium et
        elit. Duis bibendum aliquet quam et tempor. Donec quis dapibus justo. Praesent
        eget pellentesque nisi. Nulla vestibulum orci quis dui laoreet, eget posuere sem
        interdum. Morbi ac sodales ligula. Proin arcu ipsum, venenatis id cursus et,
        blandit eu mi. Sed iaculis egestas ligula, lacinia condimentum velit commodo
        non. In eu elit convallis, tempus sapien sed, maximus purus. Sed vitae enim et
        tellus accumsan bibendum eu vel turpis. Phasellus massa leo, eleifend vel
        tincidunt ut, consequat et est. Duis quis condimentum ex. Etiam nec faucibus
        lorem. Aliquam vehicula porta sapien, ut aliquam purus cursus vitae. Nullam at
        ex vehicula, egestas sapien vitae, molestie ipsum.
      <|
      <|Suspendisse iaculis lacinia arcu a vehicula. Nunc eleifend fermentum iaculis.
      <|Duis dignissim, mi sit amet vehicula auctor, odio mauris consectetur lectus, ac
      <|tincidunt lorem diam a nisi. Duis vehicula ex ac tortor sagittis, ac commodo
      <|lectus venenatis. Nam efficitur justo eros, et ornare neque aliquet ut. Duis
      <|vulputate nulla nunc, eget pellentesque diam aliquam at. Cras rhoncus orci at
      <|tortor posuere convallis sed sed risus. Quisque sed ipsum ex.
        
        Cras non semper ante. Vivamus non nulla scelerisque, fermentum sem at, laoreet
        est. Sed convallis, magna sit amet maximus sollicitudin, nulla metus sodales
        eros, eu molestie arcu urna ut nunc. Pellentesque habitant morbi tristique
        senectus et netus et malesuada fames ac turpis egestas. Morbi sollicitudin,
        turpis sit amet ultricies interdum, urna nisl rhoncus tellus, id consectetur
        urna risus ut arcu. Aliquam hendrerit eros id ex tempor vehicula. Nunc a pretium
        risus. Nulla tincidunt, mauris eu pellentesque hendrerit, nisi nibh volutpat
        sapien, vitae vehicula lacus tellus dictum augue. Pellentesque malesuada vitae
        tellus lobortis laoreet. Donec fringilla lacinia nulla sit amet eleifend.
        Suspendisse iaculis metus sed massa bibendum, quis consequat metus lacinia.
        Etiam scelerisque odio nec pulvinar dapibus. Duis interdum interdum quam vel
        dapibus. Quisque dapibus nisl quis magna accumsan, et lobortis magna eleifend.
        Ut venenatis cursus diam, vel dictum augue interdum vitae. Ut scelerisque
        condimentum augue, eget bibendum augue lacinia in.
        
        Aenean porta elit vitae pharetra dapibus. Duis a odio neque. Curabitur
        ullamcorper enim ut metus luctus, eu blandit augue consectetur. Vestibulum
        blandit lorem eget blandit fringilla. In et libero non lacus elementum pulvinar
        id a orci. Maecenas porta urna mollis, egestas lacus id, feugiat nisi. Vivamus
        imperdiet ornare dui eleifend semper. Integer erat ipsum, vestibulum a lobortis
        eu, posuere in orci. Pellentesque gravida in purus eu ullamcorper. Nunc urna
        tortor, hendrerit nec eleifend et, dapibus sed dolor.
      >|
      >|Suspendisse iaculis lacinia arcu a vehicula. Nunc eleifend fermentum iaculis.
      >|Duis dignissim, mi sit amet vehicula auctor, odio mauris consectetur lectus, ac
      >-tincidunt lorem diam a nisi. Duis vehicula ex ac tortor sagittis, ac commodo
      >+tincidunt lorem diam a nisi. Duis vehicula exe ace tortor sagittis, ac commodo
      >|lectus venenatis. Nam efficitur justo eros, et ornare neque aliquet ut. Duis
      >|vulputate nulla nunc, eget pellentesque diam aliquam at. Cras rhoncus orci at
      >|tortor posuere convallis sed sed risus. Quisque sed ipsum ex.
        
        Suspendisse convallis justo vitae leo efficitur ultrices. Fusce ullamcorper nisl
        accumsan maximus ultricies. Donec eu orci feugiat, lacinia ipsum a, rhoncus
        augue. Nullam mollis, dolor in varius auctor, ex tortor dapibus quam, id
        consectetur ipsum nunc ac leo. Maecenas condimentum nunc sed convallis ultrices.
        Suspendisse semper hendrerit ante, quis convallis dui eleifend et. Duis dui
        risus, laoreet eu suscipit eget, pretium vitae risus. Lorem ipsum dolor sit
        amet, consectetur adipiscing elit. Proin bibendum consequat pharetra. Morbi
        scelerisque vitae tellus sodales mattis.
        
        Nunc maximus porttitor nulla sit amet porta. Aenean tellus dui, viverra nec
        congue vitae, posuere a erat. Vestibulum lectus nibh, gravida et orci at,
        gravida eleifend tellus. Vestibulum nec iaculis odio. Donec et dui quis orci
        gravida euismod non sed eros. Aliquam ipsum metus, tempus a risus molestie,
        maximus vestibulum nibh. Cras sit amet sagittis nunc. Donec bibendum eros
        maximus lacus imperdiet, ac mollis quam tristique. Nunc eleifend ullamcorper"
    `);
  });

  it("test we prefer more similar lines", () => {
    const prev = `
Some code that is going to get moved somewhere. Make it long so
things are really similar. We only match on at least 3 lines
so make it 3 lines long.
a
b
c
d
e
f
`;
    const next = `
a
b
c
Some code that is going to get moved somewhere. Make it long so
things are really differs. We only match on at least 3 lines
so make it 3 lines long.
d
e
f
Some code that is going to get moved somewhere. Make it long so
things are really similar. We only match on at least 3 lines
so make it 3 lines long.
`;
    expect(testMoves(prev, next)).toMatchInlineSnapshot(`
      "-1,10 +1,13
        
      <|Some code that is going to get moved somewhere. Make it long so
      <|things are really similar. We only match on at least 3 lines
      <|so make it 3 lines long.
        a
        b
        c
      +|Some code that is going to get moved somewhere. Make it long so
      +|things are really differs. We only match on at least 3 lines
      +|so make it 3 lines long.
        d
        e
        f
      >|Some code that is going to get moved somewhere. Make it long so
      >|things are really similar. We only match on at least 3 lines
      >|so make it 3 lines long."
    `);
  });

  it("test moves of match statements", () => {
    const prev = `
let result =
  (match variable with
  | Case1 case1 ->
    let a = b in
    let double = case1 * case1 in
    a + double
  | Case2 case2 ->
    let foo = case2 ^ "-something" in
    let bar = String.length foo in
    String.is_substring (bar ^ Int.to_string) ~substring
  | Case3 case3 ->
      let one_third = case3 *. 0.3333 in
      let inverse = 1. -. one_third in
      Global.log.debug_s [%sexp "Case3"];
      let sqrt = sqrt inverse in
      let sum = ref 0. in
      List.iter [ 1; 2; 3] ~f:(fun _index ->
        sum := !sum +. sqrt;
      );
      Percentage.of_float !sum) in
fetch result
`;
    const next = `
let result =
  (match variable with
  | Case3 case3 ->
      let one_third = case3 *. 0.3333 in
      let inverse = 1. -. one_third in
      Global.log.debug_s [%sexp "Case3"];
      let sqrt = sqrt inverse in
      let sum = ref 0. in
      List.iter [ 1; 2; 3] ~f:(fun _index ->
        sum := !sum +. sqrt;
      );
      Percentage.of_float !sum
  | Case1 case1 ->
    let a = b in
    let double = case1 * case1 in
    a + double
  | Case2 case2 ->
    let foo = case2 ^ "-something" in
    let bar = String.length foo in
    String.is_substring (bar ^ Int.to_string) ~substring) in
fetch result
`;
    expect(testMoves(prev, next)).toMatchInlineSnapshot(`
      "-1,22 +1,22
        
        let result =
          (match variable with
      <|  | Case1 case1 ->
      <|    let a = b in
      <|    let double = case1 * case1 in
      <|    a + double
      <|  | Case2 case2 ->
      <|    let foo = case2 ^ "-something" in
      <|    let bar = String.length foo in
      <|    String.is_substring (bar ^ Int.to_string) ~substring
          | Case3 case3 ->
              let one_third = case3 *. 0.3333 in
              let inverse = 1. -. one_third in
              Global.log.debug_s [%sexp "Case3"];
              let sqrt = sqrt inverse in
              let sum = ref 0. in
              List.iter [ 1; 2; 3] ~f:(fun _index ->
                sum := !sum +. sqrt;
              );
      -|      Percentage.of_float !sum) in
      +|      Percentage.of_float !sum
      >|  | Case1 case1 ->
      >|    let a = b in
      >|    let double = case1 * case1 in
      >|    a + double
      >|  | Case2 case2 ->
      >|    let foo = case2 ^ "-something" in
      >|    let bar = String.length foo in
      >-    String.is_substring (bar ^ Int.to_string) ~substring
      >+    String.is_substring (bar ^ Int.to_string) ~substring) in
        fetch result"
    `);
  });

  it("make sure we don't use a replace as a move", () => {
    const prev = `
module Stable : sig
  module Row : sig
    module V1 : sig
      type t
    end

    module V2 : sig
      type t
    end

    module V3 : sig
      type t = Row.t
    end

    module V4 : sig
      type t =
        { first_name : string
        ; last_name : string
        ; age : int
        ; address : string
        ; favorite_food : string
        }
    end
  end

  module V1 : sig
    type t [@@deriving bin_io, sexp_of, compare]
  end

  module V2 : sig
    type t [@@deriving bin_io, sexp_of, compare]

    val to_v1 : t -> V1.t
  end

  module V3 : sig
    type nonrec t = t [@@deriving bin_io, sexp_of, compare]

    val to_v2 : t -> V2.t
  end

  module V4 : sig
    type t = Row.V4.t list [@@deriving bin_io, sexp_of, compare]

    val to_v3 : t -> V3.t
  end
end
`;
    const next = `
module Stable : sig
  module Row : sig
    module V1 : sig
      type t
    end

    module V2 : sig
      type t
    end

    module V3 : sig
      type t
    end

    module V4 : sig
      type t = Row.t
    end
  end

  module V1 : sig
    type t [@@deriving bin_io, sexp_of, compare]
  end

  module V2 : sig
    type t [@@deriving bin_io, sexp_of, compare]

    val to_v1 : t -> V1.t
  end

  module V3 : sig
    type t [@@deriving bin_io, sexp_of, compare]

    val to_v2 : t -> V2.t
  end

  module V4 : sig
    type nonrec t = t [@@deriving bin_io, sexp_of, compare]

    val to_v3 : t -> V3.t
  end
end
`;
    expect(testMoves(prev, next)).toMatchInlineSnapshot(`
      "-1,48 +1,42
        
        module Stable : sig
          module Row : sig
            module V1 : sig
              type t
            end
        
            module V2 : sig
              type t
            end
        
            module V3 : sig
      -|      type t = Row.t
      -|    end
      -|
      -|    module V4 : sig
      -|      type t =
      -|        { first_name : string
      -|        ; last_name : string
      -|        ; age : int
      -|        ; address : string
      -|        ; favorite_food : string
      -|        }
      +|      type t
      +|    end
      +|
      +|    module V4 : sig
      +|      type t = Row.t
            end
          end
        
          module V1 : sig
            type t [@@deriving bin_io, sexp_of, compare]
          end
        
          module V2 : sig
            type t [@@deriving bin_io, sexp_of, compare]
        
            val to_v1 : t -> V1.t
          end
        
          module V3 : sig
      -|    type nonrec t = t [@@deriving bin_io, sexp_of, compare]
      -|
      -|    val to_v2 : t -> V2.t
      -|  end
      -|
      -|  module V4 : sig
      -|    type t = Row.V4.t list [@@deriving bin_io, sexp_of, compare]
      +|    type t [@@deriving bin_io, sexp_of, compare]
      +|
      +|    val to_v2 : t -> V2.t
      +|  end
      +|
      +|  module V4 : sig
      +|    type nonrec t = t [@@deriving bin_io, sexp_of, compare]
        
            val to_v3 : t -> V3.t
          end
        end"
    `);
  });

  it("don't include deletions or additions on the edges of moves", () => {
    const prev = `
        1
        2
        3
        to_delete
        5
        6
        7
        8
        9
        10
        11
        12
        13
        14
        15
`;
    const next = `
        1
        2
        3
        8
        9
        10
        11
        12
        5
        6
        7
        added
        13
        14
        15
`;
    expect(testMoves(prev, next)).toMatchInlineSnapshot(`
      "-1,16 +1,16
        
                1
                2
                3
      -|        to_delete
      <|        5
      <|        6
      <|        7
                8
                9
                10
                11
                12
      >|        5
      >|        6
      >|        7
      +|        added
                13
                14
                15"
    `);
  });

  it("a move plus not keeping whitespace hides deleted empty lines", () => {
    const prev = `
a
b
c
d
e
f
g
h
i
j
k
l

section
to
move

m
n
o
p
`;
    const next = `
a
b
c
section
to
move
d
e
f
g
h
i
j
k
l
m
n
o
p
`;
    expect(testMoves(prev, next)).toMatchInlineSnapshot(`
      "-1,22 +1,20
        
        a
        b
        c
      >|section
      >|to
      >|move
        d
        e
        f
        g
        h
        i
        j
        k
        l
      <|section
      <|to
      <|move
        m
        n
        o
        p"
    `);
  });

  it("test moves when nesting changes", () => {
    const prev = `
let foo = 3

let bar = 4

let rec test x =
  if x > 0
  then test (x-1)
  else x
;;

let message =
  "This is a message"
;;

let call_the_server () =
  Server.call {
      user;
      password;
      request
  }
;;

let read_the_file () =
  Reader.load_sexp "some-really-long file-path.sexp"
;;
`;
    const next = `
module Server = struct
  let call_the_server () =
    Server.call {
        user;
        password;
        request
    }
  ;;

  let read_the_file () =
    Reader.load_sexp
       "some-really-long file-path.sexp"
  ;;
end

let foo = 3

let bar = 4

let rec test x =
  if x > 0
  then test (x-1)
  else x
;;

let message =
  "This is a message"
;;

include Server
`;
    expect(testMoves(prev, next)).toMatchInlineSnapshot(`
      "-1,26 +1,31
      +|
      +|module Server = struct
      >|  let call_the_server () =
      >|    Server.call {
      >|        user;
      >|        password;
      >|        request
      >|    }
      >|  ;;
      >|
      >|  let read_the_file () =
      >-  Reader.load_sexp "some-really-long file-path.sexp"
      >+    Reader.load_sexp
      >+       "some-really-long file-path.sexp"
      >|  ;;
      +|end
        
        let foo = 3
        
        let bar = 4
        
        let rec test x =
          if x > 0
          then test (x-1)
          else x
        ;;
        
        let message =
          "This is a message"
        ;;
        
      <|let call_the_server () =
      <|  Server.call {
      <|      user;
      <|      password;
      <|      request
      <|  }
      <|;;
      <|
      <|let read_the_file () =
      <|  Reader.load_sexp "some-really-long file-path.sexp"
      <|;;
      +|include Server"
    `);
  });
});
