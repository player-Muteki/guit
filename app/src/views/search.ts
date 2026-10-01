// Unified search: one field on the Main page and one layer of answers.
//
// The field asks the backend's search read and nothing else. Which history a
// scan walks, how far it has walked, what each match covers byte-for-byte and
// whether an answer is still an answer are decided in `searchModel.ts` and by
// the backend; this file holds the input, the rows and the timing, and no rule
// of its own. That split is what lets every decision here be tested by
// `node --test` with no DOM involved.
//
// Two things this layer never does. It never filters anything below it: picking
// a result asks the graph to show that commit, and the graph keeps drawing
// every row of the page it was read from, in its own topological order. And it
// never reaches the write lane — the only command reachable from here is
// `search_repository`, and what happens to a picked commit is the history
// view's own read of one page. A search that could change a repository would be
// a different product.

import { invoke } from "@tauri-apps/api/core";
import { button, el, plural } from "../dom";
import { onDispose } from "../lifecycle";
import {
  canAskAgain,
  closedLane,
  drawCommit,
  drawRef,
  drawnCommits,
  errorCode,
  hasMark,
  hasRows,
  hiddenCommits,
  isSettled,
  mergePage,
  nextQueryId,
  nothingMatched,
  otherFields,
  outcomeOf,
  refsUsable,
  STOP_SCAN_CAP,
  typed,
  unansweredNames,
  type CommitHit,
  type HitField,
  type RefHit,
  type RefKind,
  type SearchLane,
  type SearchPage,
  type SearchResult,
  type Segment,
  type Typing,
} from "../searchModel";
import { contextMatches, readContextFor } from "../snapshotBus";
import { currentSnapshot } from "../state";
import type { ReadContext, SessionRead } from "../types";

export interface SearchDeps {
  onError(error: unknown): void;
  /** Asks the graph to show one commit. How it gets there is the graph's call. */
  revealCommit(oid: string): void;
}

export interface SearchView {
  element: HTMLElement;
  sync(): void;
  render(): void;
  /** Puts the caret in the field — how a keyboard reader reaches search. */
  focusField(): void;
}

// Naming a fact the model already established is not a decision, so the words
// live here and the predicates do not.
const FIELD_WORDS: Record<HitField, string> = {
  oid: "its commit id",
  subject: "its message",
  body: "its message body",
  author: "its author",
};

const KIND_WORDS: Record<RefKind, string> = {
  branch: "Branch",
  tag: "Tag",
  remote: "Remote ref",
};

const runText = (runs: readonly Segment[]): (string | HTMLElement)[] =>
  runs.map((run) => (run.marked ? el("span", { class: "search-mark", text: run.text }) : run.text));

export function createSearchView(deps: SearchDeps): SearchView {
  const element = el("section", { class: "search-view", hidden: true });

  const field = el("input", {
    class: "input search-field",
    type: "search",
    placeholder: "Search commits, branches and tags",
    "aria-label": "Search commits, branches and tags",
    role: "combobox",
    "aria-expanded": "false",
    "aria-controls": "search-list",
    autocomplete: "off",
    spellcheck: false,
  }) as HTMLInputElement;
  const hint = el("span", { class: "search-hint", role: "status" });
  const bar = el("div", { class: "search-bar" }, [field, hint]);

  const list = el("div", {
    class: "search-list",
    role: "listbox",
    id: "search-list",
    "aria-label": "Search results",
  });
  const more = button("Search further back", () => askMore(), { class: "btn btn-quiet" });
  const summary = el("span", { class: "search-summary" });
  const footer = el("div", { class: "search-footer" }, [summary, more]);
  const results = el("div", { class: "search-results", hidden: true }, [list, footer]);
  element.append(bar, results);

  let requestSeq = 0;
  // The graph context the answer on screen was read from. It is both the
  // `asked` of a request in flight and what a late answer is compared against.
  let synced: ReadContext | null = null;
  // Which keystroke this panel last asked about, and the session that numbering
  // belongs to: `queryId` restarts in a new session because the backend's lane
  // is keyed on the pair.
  let lane: SearchLane = closedLane(0);
  let typing: Typing | null = null;
  let timer: number | undefined;
  // The text the rows on screen answer. A continuation reuses it, because the
  // next window is the same question asked further back.
  let currentQuery = "";
  let result: SearchResult | null = null;
  let asking = false;
  let refusal: string | null = null;
  // The reader's own decision about the layer. Visibility is this flag *and*
  // there being something to show, so a repaint cannot re-open a layer the
  // reader closed, and a scan that comes back empty does not keep one open.
  let wanted = false;
  let composing = false;
  let active = -1;

  const now = (): number => Date.now();

  const dismiss = (): void => {
    wanted = false;
    active = -1;
    field.removeAttribute("aria-activedescendant");
  };

  // Stops a scan that is no longer answering a question on screen. A fresh
  // query displaces the old one by itself — the backend stops the lane when a
  // newer question claims it — but an emptied field never claims anything, so
  // without this the scan under way would be walked to its window's end for an
  // answer nobody is waiting for. It names the question by the pair the lane is
  // keyed on, so a field that was cleared and retyped stops the question that
  // was on screen, never the one being asked now.
  const stopScan = (): void => {
    if (lane.queryId === 0 || lane.sessionId === 0) return;
    void invoke("cancel_search", { sessionId: lane.sessionId, queryId: lane.queryId });
  };

  // --- asking -------------------------------------------------------

  const clearAnswer = (): void => {
    result = null;
    currentQuery = "";
    refusal = null;
    dismiss();
  };

  const send = async (query: string, cursor: number, fresh: boolean): Promise<void> => {
    const asked = synced;
    if (asked === null) return;
    let queryId = lane.queryId;
    if (fresh) {
      const next = nextQueryId(lane, asked.sessionId);
      lane = next.lane;
      queryId = next.queryId;
      // A new question retires the answer to the old one: the rows below the
      // field describe the text the reader has just replaced.
      result = null;
      refusal = null;
      currentQuery = query;
      active = -1;
      wanted = true;
    } else if (result === null) {
      return;
    }
    const seq = ++requestSeq;
    asking = true;
    render();
    try {
      const read = await invoke<SessionRead<SearchPage>>("search_repository", {
        context: asked,
        queryId,
        query,
        cursor,
      });
      // Two checks, neither a judgement about the answer's content: the screen
      // has to still be the one that asked, and the model then decides whether
      // the answer belongs to the question on screen.
      if (seq !== requestSeq) return;
      if (synced === null || !contextMatches(asked, synced)) return;
      const merged = mergePage(result, lane, asked, read);
      if (merged.rejected === null) result = merged.result;
      else if (merged.rejected === "session") clearAnswer();
      refusal = null;
    } catch (error) {
      if (seq !== requestSeq) return;
      const outcome = outcomeOf(errorCode(error));
      if (outcome === "closed") {
        // The rows describe a repository that is no longer open. Nothing else
        // may be kept from it, and nothing may be asked in its name again.
        clearAnswer();
      } else if (outcome === "overtaken") {
        // The answer the panel wanted is the one still on its way, and what is
        // on screen still answers the question the field asks. Silent, on
        // purpose: this is not a failure the reader can act on.
      } else {
        refusal = "The search could not be read.";
        deps.onError(error);
      }
    } finally {
      asking = false;
      if (seq === requestSeq) render();
    }
  };

  const askMore = (): void => {
    if (asking || result === null || !canAskAgain(result)) return;
    void send(currentQuery, result.nextCursor ?? 0, false);
  };

  // The wait itself is the model's (`typed`), so a test and the read budget both
  // see it as a number. This function owns only the timer it is spent in.
  const schedule = (): void => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    const state = typing;
    if (state === null) return;
    if (state.query === null) {
      // An empty field is not a half-typed question; it is no question at all.
      stopScan();
      clearAnswer();
      render();
      return;
    }
    if (state.askAt === null) return;
    const query = state.query;
    timer = window.setTimeout(() => {
      timer = undefined;
      void send(query, 0, true);
    }, Math.max(0, state.askAt - now()));
  };

  const onInput = (): void => {
    typing = typed(field.value, composing, now());
    schedule();
    render();
  };

  // --- picking ------------------------------------------------------

  const picked = (oid: string | null): void => {
    if (oid === null) return;
    dismiss();
    render();
    deps.revealCommit(oid);
  };

  // --- drawing ------------------------------------------------------

  // Rows are counted separately from the elements that hold them, because the
  // heading between the commits and the names is drawn but is not a row a key
  // can land on.
  let rowAt = 0;

  const commitRow = (commit: CommitHit): HTMLElement => {
    const index = rowAt;
    rowAt += 1;
    const drawn = drawCommit(commit);
    const best = commit.hits.length === 0 ? null : commit.hits[0];
    const extra = otherFields(commit);
    const matched = [
      best === null ? "" : `matched ${FIELD_WORDS[best.field]}`,
      extra === 0 ? "" : `+${plural(extra, "more field")}`,
    ]
      .filter((part) => part !== "")
      .join(", ");
    const row = el("button", {
      class: `search-row${index === active ? " active" : ""}`,
      type: "button",
      role: "option",
      id: `search-row-${index}`,
      "aria-selected": String(index === active),
    }, [
      el("span", { class: "search-row-line" }, runText(drawn.subject)),
      // The body earns its line only when the match is in it: a row that
      // repeated its own subject underneath itself would spend the layer's
      // height saying nothing.
      ...(hasMark(drawn.body) ? [el("span", { class: "search-row-body" }, runText(drawn.body))] : []),
      el("span", { class: "search-row-meta" }, [
        el("span", { class: "search-row-oid" }, runText(drawn.oid)),
        el("span", { class: "search-row-author", text: commit.authorName }),
        el("span", { class: "search-row-date", text: commit.commitDate.slice(0, 10) }),
        ...(matched === "" ? [] : [el("span", { class: "search-row-hit", text: matched })]),
      ]),
    ]);
    row.addEventListener("click", () => picked(commit.oid));
    return row;
  };

  const refRow = (ref: RefHit): HTMLElement => {
    const index = rowAt;
    rowAt += 1;
    // A name that names no commit cannot be shown in the graph, and the reason
    // is a fact about the tag rather than a read that failed. A remote-tracking
    // ref is the last state Git recorded about a remote, which is what the
    // tooltip says rather than what showing it beside a branch would imply.
    const oid = ref.commitOid;
    const note =
      oid === null
        ? "names no commit"
        : ref.reachedFromHead === false
          ? "outside this branch's history"
          : ref.head
            ? "checked out"
            : ref.reachedFromHead === null
              ? "reach not asked"
              : "";
    const row = el("button", {
      class: `search-row search-ref${index === active ? " active" : ""}${oid === null ? " inert" : ""}`,
      type: "button",
      role: "option",
      id: `search-row-${index}`,
      "aria-selected": String(index === active),
      disabled: oid === null,
      title: ref.kind === "remote"
        ? "A remote-tracking ref: what Git last recorded about a remote, not its current state."
        : note,
    }, [
      el("span", { class: "search-ref-kind", text: KIND_WORDS[ref.kind] }),
      el("span", { class: "search-row-line" }, runText(drawRef(ref))),
      ...(note === "" ? [] : [el("span", { class: "search-row-hit", text: note })]),
    ]);
    if (oid !== null) row.addEventListener("click", () => picked(oid));
    return row;
  };

  const namesOnScreen = (held: SearchResult): boolean => {
    const snapshot = currentSnapshot();
    return snapshot !== null && refsUsable(held, snapshot.refsGeneration);
  };

  // What the answer says it is. Every clause here is a state the model decided;
  // this function only puts them in one sentence, because a footer that could
  // not tell "stopped early" from "found nothing" would be worse than silent.
  const summaryOf = (held: SearchResult): string => {
    const parts: string[] = [];
    if (nothingMatched(held)) parts.push("Nothing matched");
    else if (held.commits.length === 0 && held.refs.length === 0 && !isSettled(held))
      // The one empty state that is not an answer: the walk has not reached the
      // older history yet, so the button beside this sentence is the rest of it.
      parts.push("Nothing in the history read so far");
    else {
      parts.push(`${plural(held.commits.length, "commit")} matched`);
      const left = hiddenCommits(held);
      // "more" is not a countable thing, so this one does not go through `plural`:
      // the sentence the reader gets is "60 more not listed", not a plural of a
      // word that has no plural.
      if (left > 0) parts.push(`${left} more not listed`);
      if (held.refs.length > 0) {
        parts.push(namesOnScreen(held) ? `${plural(held.refs.length, "name")} matched` : "the names changed mid-search, so none are listed");
      }
    }
    if (held.hitsTruncated) parts.push("more matched than this window returned");
    if (held.stoppedBy === STOP_SCAN_CAP) parts.push("stopped at the scan limit, so this is not the whole history");
    else if (!held.complete && !canAskAgain(held)) parts.push("the scan stopped before it finished");
    const waiting = unansweredNames(held);
    if (waiting > 0 && namesOnScreen(held)) parts.push(`${plural(waiting, "name")} had no reach answer`);
    return `${parts.join("; ")}. ${plural(held.scanned, "commit")} scanned.`;
  };

  const renderRows = (): void => {
    rowAt = 0;
    const held = result;
    if (held === null) {
      list.replaceChildren();
      field.removeAttribute("aria-activedescendant");
      return;
    }
    const rows: HTMLElement[] = [];
    for (const commit of drawnCommits(held)) rows.push(commitRow(commit));
    if (held.refs.length > 0 && namesOnScreen(held)) {
      rows.push(el("div", { class: "search-heading", text: "Names" }));
      for (const ref of held.refs) rows.push(refRow(ref));
    }
    list.replaceChildren(...rows);
    if (active >= rowAt) active = rowAt - 1;
    if (active < 0) field.removeAttribute("aria-activedescendant");
    else field.setAttribute("aria-activedescendant", `search-row-${active}`);
  };

  // --- the row the keys are on --------------------------------------

  const step = (by: number): void => {
    if (rowAt === 0) return;
    active = Math.min(Math.max(active + by, 0), rowAt - 1);
    renderRows();
    list.querySelector<HTMLElement>(`#search-row-${active}`)?.scrollIntoView({ block: "nearest" });
  };

  const activate = (): void => {
    const row = list.querySelector<HTMLButtonElement>(`#search-row-${active}`);
    if (row === null || row.disabled) return;
    row.click();
  };

  // --- events -------------------------------------------------------

  field.addEventListener("input", onInput);
  // A composition is one question told in several keystrokes, and none of the
  // pieces in the middle of one is ever sent. The end of one re-enters through
  // the ordinary path, which restarts the count for the text that landed.
  field.addEventListener("compositionstart", () => {
    composing = true;
    schedule();
  });
  field.addEventListener("compositionend", () => {
    composing = false;
    onInput();
  });
  field.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        step(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        step(-1);
        return;
      case "Home":
        if (rowAt === 0) return;
        event.preventDefault();
        active = 0;
        renderRows();
        return;
      case "End":
        if (rowAt === 0) return;
        event.preventDefault();
        active = rowAt - 1;
        renderRows();
        return;
      case "Enter":
        if (active < 0) return;
        event.preventDefault();
        activate();
        return;
      case "Escape":
        // Escape stops here. The layer is the topmost thing this page drew, so
        // the first press closes it and leaves the text for the next one.
        if (!results.hidden) {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
          render();
        }
        return;
      default:
        return;
    }
  });
  field.addEventListener("focus", () => {
    if (hasRows(result)) wanted = true;
    render();
  });
  field.addEventListener("search", onInput);

  const onOutside = (event: MouseEvent): void => {
    if (results.hidden) return;
    if (element.contains(event.target as Node)) return;
    dismiss();
    render();
  };
  document.addEventListener("click", onOutside, true);
  onDispose(() => {
    document.removeEventListener("click", onOutside, true);
    if (timer !== undefined) window.clearTimeout(timer);
    stopScan();
  });

  // --- lifecycle ----------------------------------------------------

  // The search is a read of the history on screen, so it follows the graph's own
  // rule: the backend's counter says when that history moved, and a move
  // retires whatever was answering the history before it.
  const sync = (): void => {
    const snapshot = currentSnapshot();
    if (snapshot === null) {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      stopScan();
      typing = null;
      field.value = "";
      synced = null;
      lane = closedLane(0);
      clearAnswer();
      render();
      return;
    }
    const context = readContextFor(snapshot, "graph");
    if (synced !== null && contextMatches(synced, context)) return;
    if (lane.sessionId !== context.sessionId) lane = closedLane(context.sessionId);
    synced = context;
    clearAnswer();
    // The reader's query is still in the field, so the same question is asked
    // of the history that replaced the old one — one read, on the same wait any
    // other keystroke pays.
    typing = typed(field.value, composing, now());
    if (typing.query !== null && typing.askAt !== null) schedule();
    else render();
  };

  const render = (): void => {
    const snapshot = currentSnapshot();
    field.disabled = snapshot === null;
    // The layer has to have something to say. A first window still on its way
    // is not an answer, and drawing its empty box would show a footer that
    // claims a scan has not run yet; the hint beside the field says that
    // instead. Once any window has arrived the layer stays up even while the
    // next one is being asked for, because what it holds is true of the
    // history read so far.
    const shown = refusal !== null || hasRows(result) || (result !== null && !asking);
    results.hidden = !(wanted && shown) || snapshot === null;
    element.hidden = snapshot === null;
    field.setAttribute("aria-expanded", String(!results.hidden));
    more.hidden = result === null || !canAskAgain(result) || asking;
    more.disabled = asking;
    hint.textContent = refusal ?? (asking && !hasRows(result) ? "Searching…" : "");
    summary.textContent = result === null ? "" : summaryOf(result);
    renderRows();
  };

  return {
    element,
    sync,
    render,
    focusField: () => {
      field.focus();
      field.select();
    },
  };
}
