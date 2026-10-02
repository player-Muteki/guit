// The shape an empty region wears.
//
// Three of this panel's regions can be empty, and each empty state used to be
// one line of grey text. In a 340x400 window that makes "there is nothing to
// read here" and "something failed" the same thing to look at: same weight,
// same colour, same shape. The graph already has a vocabulary for "a history
// that goes somewhere" — a lane, a node, a ring for the first commit, a dash
// for a path that leaves what is loaded — and this draws the empty states in
// that same vocabulary rather than inventing an illustration the panel has no
// room for.
//
// Each figure is one of four, drawn as SVG in the graph's own geometry, and all
// four are the same lane language at different stages:
//
//   clean     a node at the head with the lane going nowhere below it — the
//             working copy matches the last commit and there is nothing new
//   no-commits an empty ring, the shape the graph already uses for a root
//             commit, with no commit inside it yet
//   unavailable a dashed lane that stops short: the shape the graph already
//             uses for history that continues below what is loaded, pointed
//             the other way — here it is the reading that could not be got
//   no-repo   two stub lanes and no node, before there is anything to draw on
//
// The figures are decorative. They are `aria-hidden`, they carry no text, and
// the sentence that already said what is wrong is untouched and still the
// element that carries it: an empty state's meaning is its words, and the shape
// is there so the words are not floating alone in an undifferentiated box.

const SVG_NS = "http://www.w3.org/2000/svg";

export type EmptyKind = "clean" | "no-commits" | "unavailable" | "no-repo";

/** Show or hide a figure.
 *
 * `hidden` is an HTML global attribute and is not on `SVGSVGElement`, so this is
 * the attribute rather than the IDL property. It is not decoration: `hidden` is
 * what removes a figure from the accessibility tree as well as from the paint,
 * and an un-hidden-but-invisible figure would be exactly the kind of thing that
 * survives a review. The `[hidden]` rule in the sheet is what makes the
 * attribute hide an SVG element too, which the UA default does not cover. */
export function showFigure(figure: SVGSVGElement, shown: boolean): void {
  figure.toggleAttribute("hidden", !shown);
}

/** Build one decorative figure. Everything about it is fixed at build time —
 * no repository text ever reaches here, so there is nothing to escape. */
export function emptyFigure(kind: EmptyKind): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "empty-figure");
  svg.setAttribute("viewBox", "0 0 32 40");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const line = (x: number, y1: number, y2: number, dashed = false): SVGElement => {
    const node = document.createElementNS(SVG_NS, "path");
    node.setAttribute("class", "empty-figure-line");
    node.setAttribute("d", `M${x} ${y1}V${y2}`);
    if (dashed) node.setAttribute("data-dash", "true");
    return node;
  };
  const node = (cx: number, cy: number, shape: "normal" | "root"): SVGElement => {
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("class", "empty-figure-node");
    circle.setAttribute("cx", String(cx));
    circle.setAttribute("cy", String(cy));
    circle.setAttribute("r", "3.5");
    circle.setAttribute("data-shape", shape);
    return circle;
  };

  const parts: SVGElement[] = [];
  switch (kind) {
    case "clean":
      // One node at the head, the lane running down and simply ending. Nothing
      // branches off it because nothing has been added since.
      parts.push(line(16, 12, 32), node(16, 8, "normal"));
      break;
    case "no-commits":
      // The root shape the graph draws for a first commit, held empty.
      parts.push(line(16, 14, 32), node(16, 9, "root"));
      break;
    case "unavailable":
      // A lane that stops short with the rest dashed: the history continues
      // somewhere this could not read.
      parts.push(line(16, 8, 20), line(16, 24, 26, true), line(16, 30, 34, true));
      break;
    case "no-repo":
      // Two stubs, no node: there is no commit yet to hang one on.
      parts.push(line(12, 12, 24), line(20, 16, 28));
      break;
  }
  for (const part of parts) svg.append(part);
  return svg;
}