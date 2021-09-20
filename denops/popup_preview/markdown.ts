import { batch, Denops, fn, gather, vars } from "./deps.ts";
type MarkedString = string | { language: string; value: string };
export type MarkupKind = "plaintext" | "markdown";
export type MarkupContent = {
  kind: MarkupKind;
  value: string;
};

// --- Converts any of `MarkedString` | `MarkedString[]` | `MarkupContent` into
// --- a list of lines containing valid markdown. Useful to populate the hover
// --- window for `textDocument/hover`, for parsing the result of
// --- `textDocument/signatureHelp`, and potentially others.
// ---
// --@param input (`MarkedString` | `MarkedString[]` | `MarkupContent`)
// --@param contents (table, optional, default `{}`) List of strings to extend with converted lines
// --@returns {contents}, extended with lines of converted markdown.
// --@see https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_hover
export function convertInputToMarkdownLines(
  input: MarkedString | MarkedString[] | MarkupContent,
  contents: string[],
): string[] {
  if (typeof input == "string") {
    contents = contents.concat(input.split("\n"));
  } else {
    if ("kind" in input) {
      let value = input.value;
      if (input.kind == "plaintext") {
        value = "<text>\n" + input.value + "\n</text>";
      }
      contents = contents.concat(value.split("\n"));
    } else if ("language" in input) {
      // MarkedString
      contents.push("```" + input.language);
      contents = contents.concat(input.value.split("\n"));
      contents.push("```");
    } else {
      contents = input.flatMap((mstr) =>
        convertInputToMarkdownLines(mstr, contents)
      );
    }
  }
  if (contents.length == 1 && contents[0] == "") {
    return [];
  }

  return contents;
}

// TODO: check border
export async function makeFloatingwinSize(
  denops: Denops,
  lines: string[],
  maxWidth: number,
  maxHeight: number,
): Promise<[number, number]> {
  const widths = await gather(denops, async (denops) => {
    for (const line of lines) {
      await fn.strdisplaywidth(denops, line);
    }
  }) as number[];
  const width = Math.min(Math.max(...widths), maxWidth);

  let height = 0;
  for (const w of widths) {
    height += Math.floor((w ? w - 1 : 0) / width) + 1;
  }
  height = Math.min(maxHeight, height);
  return [width, height];
}

export function getMarkdownFences(items: string[]) {
  const fences: Record<string, string> = {};
  for (const item of items) {
    const maybe = item.split("=");
    if (maybe.length == 2) {
      fences[maybe[0]] = maybe[1];
    }
  }
  return fences;
}

type Matcher = {
  ft: string;
  begin: string;
  end: string;
};

type Match = {
  ft: string | null;
  type: string;
};

type Highlight = {
  ft: string | null;
  start: number;
  finish: number;
};

type HighlightContent = {
  stripped: string[];
  highlights: Highlight[];
  width: number;
  height: number;
};

type HighlightContext = {
  stripped: string[];
  commands: string[];
  width: number;
  height: number;
};

export async function getHighlights(
  denops: Denops,
  contents: string[],
  opts: FloatOption,
): Promise<HighlightContent> {
  if (opts.syntax != "markdown") {
    if (!opts.syntax.length || opts.syntax == 'plaintext'){
      opts.syntax = "plaintex"
    }
    contents[0] = "```" + opts.syntax + " " + contents[0];
    contents[contents.length - 1] = contents[contents.length - 1] + " ```";
    const [width, height] = await makeFloatingwinSize(
      denops,
      contents,
      opts.maxWidth,
      opts.maxHeight,
    );
    return {
      stripped: contents,
      width: width,
      height: height,
      highlights: [],
    };
  }
  const matchers: Record<string, Matcher> = {
    block: { ft: "", begin: "```+([a-zA-Z0-9_]*)", end: "```+" }, // block
    pre: { ft: "", begin: "<pre>", end: "<\/pre>" }, // pre
    code: { ft: "", begin: "<code>", end: "<\/code>" }, // code
    text: { ft: "plaintex", begin: "<text>", end: "<\/text>" }, // text
  };
  const fences = getMarkdownFences(
    await vars.g.get(
      denops,
      "markdown_fenced_languages",
      [],
    ) as string[],
  );

  function matchBegin(line: string): Match | null {
    for (const type of Object.keys(matchers)) {
      const matcher = matchers[type];
      const match = line.match(matcher.begin);
      if (match) {
        return {
          type: type,
          ft: matcher.ft ? matcher.ft : match[1] ? match[1] : null,
        };
      }
    }
    return null;
  }

  function matchEnd(line: string, match: Match): boolean {
    return line.search(matchers[match.type].end) != -1;
  }

  const stripped: string[] = [];
  const highlights: Highlight[] = [];
  const markdownLines: boolean[] = [];
  for (let i = 0; i < contents.length;) {
    const line = contents[i];
    const match = matchBegin(line);
    if (match) {
      const start = stripped.length;
      if (match.ft) {
        match.ft = fences[match.ft] ? fences[match.ft] : match.ft;
      }
      i++;
      if (contents[i] && !matchEnd(contents[i], match)) {
        stripped.push("```" + match.ft + " " + contents[i]);
        i++;
      }
      while (i < contents.length) {
        const fencedLine = contents[i];
        if (matchEnd(fencedLine, match)) {
          stripped[stripped.length - 1] = stripped[stripped.length - 1] +
            " ```";
          i++;
          break;
        }
        stripped.push(fencedLine);
        i++;
      }
      highlights.push({
        ft: match.ft,
        start: start + 1,
        finish: stripped.length,
      });
      // add separator
      if (i < contents.length) {
        stripped.push("---");
        markdownLines[stripped.length - 1] = true;
      }
    } else {
      // strip any emty lines or separators prior to this separator in actual markdown
      if (/^---+$/.test(line)) {
        while (
          markdownLines[stripped.length - 1] &&
          (/^\s*$/.test(stripped[stripped.length - 1]) ||
            (/^---+$/.test(stripped[stripped.length - 1])))
        ) {
          markdownLines[stripped.length - 1] = false;
          stripped.pop();
        }
      }
      // add the line if its not an empty line following a separator
      if (
        !(/^\s*$/.test(line) && markdownLines[stripped.length - 1] &&
          /^---+$/.test(stripped[stripped.length - 1]))
      ) {
        stripped.push(line);
        markdownLines[stripped.length - 1] = true;
      }
      i++;
    }
  }

  const [width, height] = await makeFloatingwinSize(
    denops,
    stripped,
    opts.maxWidth,
    opts.maxHeight,
  );
  const sepLine = "─".repeat(width);
  // replace --- with line separator
  for (let i = 0; i < stripped.length; i++) {
    if (/^---+$/.test(stripped[i]) && markdownLines[i]) {
      stripped[i] = sepLine;
    }
  }
  return {
    stripped: stripped,
    highlights: highlights,
    width: width,
    height: height,
  };
}

// --- Converts markdown into syntax highlighted regions by stripping the code
// --- blocks and converting them into highlighted code.
// --- This will by default insert a blank line separator after those code block
// --- regions to improve readability.
// ---
// --- This method configures the given buffer and returns the lines to set.
// ---
// --- If you want to open a popup with fancy markdown, use `open_floating_preview` instead
// ---
// ---@param contents table of lines to show in window
// ---@param opts dictionary with optional fields
// ---  - height    of floating window
// ---  - width     of floating window
// ---  - wrap_at   character to wrap at for computing height
// ---  - max_width  maximal width of floating window
// ---  - max_height maximal height of floating window
// ---  - pad_left   number of columns to pad contents at left
// ---  - pad_right  number of columns to pad contents at right
// ---  - pad_top    number of lines to pad contents at top
// ---  - pad_bottom number of lines to pad contents at bottom
// ---  - separator insert separator after code block
// ---@returns width,height size of float
type FloatOption = {
  maxWidth: number;
  maxHeight: number;
  separator?: string;
  syntax: string;
};

// export async function getStylizeCommands(
//   denops: Denops,
//   lines: string[],
//   opts: FloatOption,
// ): Promise<HighlightContext> {
//   const hiContents = await getHighlights(denops, lines, opts);
//   const fences = getMarkdownFences(
//     opts.fences,
//   );
//   const cmds: string[] = [];
//   let index = 0;
//   const langs: Record<string, boolean> = {};
//   function applySyntax(
//     ft: string | null,
//     start: number,
//     finish: number,
//   ) {
//     if (!ft) {
//       cmds.push(
//         `syntax region markdownCode start=/\\%${start}l/ end=/\\%${finish +
//           1}l/ keepend extend`,
//       );
//       return;
//     }
//     ft = fences[ft] ? fences[ft] : ft;
//     const name = ft + index;
//     index++;
//     const lang = "@" + ft.toUpperCase();
//     if (!langs[lang]) {
//       cmds.push("unlet! b:current_syntax");
//       cmds.push(`silent! syntax include ${lang} syntax/${ft}.vim`);
//       langs[lang] = true;
//     }
//     cmds.push(
//       `syntax region ${name} start=/\\%${start}l/ end=/\\%${finish +
//         1}l/ contains=${lang} keepend`,
//     );
//   }
//
//   cmds.push("syntax clear");
//
//   let last = 1;
//   for (const hi of hiContents.highlights) {
//     if (last < hi.start) {
//       applySyntax("popup_preview_markdown", last, hi.start - 1);
//     }
//     applySyntax(hi.ft, hi.start, hi.finish);
//     last = hi.finish + 1;
//   }
//   if (last < hiContents.stripped.length) {
//     applySyntax("popup_preview_markdown", last, hiContents.stripped.length);
//   }
//   return {
//     stripped: hiContents.stripped,
//     commands: cmds,
//     width: hiContents.width,
//     height: hiContents.height,
//   };
// }
