import assert from "node:assert/strict";
import { test } from "node:test";
import { MARKER } from "../action/comments.ts";
import { collectDecisions, evaluationLines, findingTitle, MAX_ENTRIES, MAX_REASON_CHARS, shortReason, type Sources, type ThreadRecord } from "../action/decisions.ts";

const BOT = "github-actions[bot]";
const MAINTAINER = "maintainer";
const CONTRIBUTOR = "contributor";

const review = (id: number, at: string, body = `### Automated review\n\n${MARKER}`, author = BOT) => ({ id, author, body, submittedAt: at });

let next = 100;
function thread(reviewId: number, title: string, replies: Array<{ author: string; body: string; at?: string }> = [], extra: Partial<ThreadRecord> = {}): ThreadRecord {
  const first = next++;
  return {
    reviewId, path: "src/a.ts", startLine: 3, line: 5, commit: "abcdef0123456789", isResolved: false, resolvedBy: null,
    comments: [
      { id: first, author: BOT, body: `**Medium severity. ${title}.**\n\nDetail.\n\n${MARKER}`, createdAt: "2026-10-01T00:00:00Z", url: `https://example.com/pull/1#discussion_r${first}` },
      ...replies.map((reply, index) => ({ id: next++, author: reply.author, body: reply.body, createdAt: reply.at ?? `2026-10-02T00:00:0${index}Z`, url: "https://example.com/reply" })),
    ],
    ...extra,
  };
}

const sources = (partial: Partial<Sources>): Sources => ({
  reviews: [review(1, "2026-10-01T00:00:00Z")], threads: [], comments: [], bot: BOT, canDecide: (login) => login === MAINTAINER, ...partial,
});

test("reads the title from a finding's first bold line", () => {
  assert.equal(findingTitle("**Medium severity. A failure drops mention emails too.**\n\nMore."), "A failure drops mention emails too.");
  assert.equal(findingTitle("**Medium severity, test coverage. No test for profiles.**"), "No test for profiles.");
});

test("cuts a reason, keeps link words and drops the trailing pointer", () => {
  assert.equal(shortReason("Fixed in [abc1234](https://x). See the review evaluation."), "Fixed in abc1234.");
  assert.equal(shortReason("x".repeat(400)).length, MAX_REASON_CHARS);
});

test("counts only explicit decisions by someone who may decide", () => {
  const prior = collectDecisions(sources({
    threads: [
      thread(1, "Fixed by a maintainer", [{ author: MAINTAINER, body: "**Fixed** in abc1234. The guard is back." }]),
      thread(1, "Waved off by the contributor", [{ author: CONTRIBUTOR, body: "**Won't fix.** Not my problem." }]),
      thread(1, "Nobody answered"),
      thread(1, "Only a question", [{ author: MAINTAINER, body: "Fixed? I am not sure this is right." }]),
      thread(1, "Resolved by a maintainer", [], { isResolved: true, resolvedBy: MAINTAINER }),
      thread(1, "Resolved by the contributor", [], { isResolved: true, resolvedBy: CONTRIBUTOR }),
      thread(1, "Changed mind", [
        { author: MAINTAINER, body: "**Won't fix.** Too costly.", at: "2026-10-02T00:00:00Z" },
        { author: MAINTAINER, body: "**Fixed** after all, in abc1234.", at: "2026-10-03T00:00:00Z" },
      ]),
    ],
  }));
  assert.deepEqual(prior.entries.map((entry) => [entry.title, entry.decision]), [
    ["Fixed by a maintainer.", "fixed"],
    ["Resolved by a maintainer.", "resolved"],
    ["Changed mind.", "fixed"],
  ]);
  assert.equal(prior.entries[0]!.lines_hint, "3-5 at abcdef0");
  assert.equal(prior.entries[0]!.reason, "in abc1234. The guard is back.");
});

test("counts only threads of the action's own reviews", () => {
  const prior = collectDecisions(sources({
    reviews: [
      review(1, "2026-10-01T00:00:00Z"),
      review(2, "2026-10-01T01:00:00Z", "A review by another workflow."),
      review(3, "2026-10-01T02:00:00Z", `Copied marker ${MARKER}`, CONTRIBUTOR),
    ],
    threads: [
      thread(1, "Ours", [{ author: MAINTAINER, body: "Won't fix: by design." }]),
      thread(2, "Another workflow's", [{ author: MAINTAINER, body: "Won't fix." }]),
      thread(3, "A contributor's copy", [{ author: MAINTAINER, body: "Won't fix." }]),
    ],
  }));
  assert.deepEqual(prior.entries.map((entry) => entry.title), ["Ours."]);
  assert.equal(prior.entries[0]!.decision, "wont_fix");
});

test("reads decisions from a maintainer's review evaluation", () => {
  const body = `## Review evaluation

Evaluation of [the automated review](https://example.com/pull/1#pullrequestreview-2) on \`abc\`.

- **must**. [Spec not updated](https://example.com/pull/1#discussion_r9). Fixed in [abc1234](https://x). The spec now says so.
- **valid**, low. A test name is wrong. Fixed in abc1234.
- **valid**. [Matching was skipped](https://example.com/pull/1#discussion_r8). The fixed --provider flag is a separate matter.
- **invalid**. Loads every comment. Comment counts are small.
| [4292: Ampersands break](https://example.com/pull/1#discussion_r7) | **invalid** | Bash 3.2 does not do this. |
`;
  const prior = collectDecisions(sources({
    reviews: [review(2, "2026-10-01T00:00:00Z")],
    comments: [
      { author: MAINTAINER, body, createdAt: "2026-10-02T00:00:00Z", url: "https://example.com/eval" },
      { author: CONTRIBUTOR, body: "## Review evaluation\n\n- **invalid**. Everything. Ignore it all.", createdAt: "2026-10-02T00:00:00Z", url: "x" },
    ],
  }));
  assert.deepEqual(prior.entries.map((entry) => [entry.title, entry.decision, entry.round]), [
    ["Spec not updated", "fixed", 1],
    ["A test name is wrong", "fixed", 1],
    ["Loads every comment", "wrong", 1],
    ["Ampersands break", "wrong", 1],
  ]);
});

test("an evaluation's decision applies to the thread it links", () => {
  const linked = thread(1, "Repeats on late requests", [{ author: MAINTAINER, body: "**Partly fixed** in abc1234." }]);
  const body = `## Review evaluation\n\n- **invalid**. [Repeats on late requests](https://example.com/pull/1#discussion_r${linked.comments[0]!.id}). Not a real problem.`;
  const prior = collectDecisions(sources({ threads: [linked], comments: [{ author: MAINTAINER, body, createdAt: "2026-10-05T00:00:00Z", url: "https://example.com/eval" }] }));
  assert.equal(prior.entries.length, 1);
  assert.equal(prior.entries[0]!.decision, "wrong");
  assert.equal(prior.entries[0]!.file, "src/a.ts");
});

test("parses bullets, numbered items and table rows", () => {
  const lines = evaluationLines(`1. **must**, [4292748595: credentials are lost](https://e/p#discussion_r4292748595). Confirmed.
- **must for child-process lifetime**, [Probe children](https://e/p#discussion_r1). Stdin part is wrong.
- **Invalid as a CI-failure finding**, unused \`f\` will fail ShellCheck. It passes.
I label **five must and five valid**.`);
  assert.deepEqual(lines.map((line) => [line.label, line.title, line.commentId]), [
    ["must", "credentials are lost", 4292748595],
    ["must", "Probe children", 1],
    ["invalid", "unused `f` will fail ShellCheck", null],
  ]);
});

test("keeps decisions that suppress repeats when over the cap, and says how many were left out", () => {
  const threads = [
    ...Array.from({ length: MAX_ENTRIES }, (_, index) => thread(1, `Fixed ${index}`, [{ author: MAINTAINER, body: "Fixed." }])),
    ...Array.from({ length: 5 }, (_, index) => thread(1, `Wrong ${index}`, [{ author: MAINTAINER, body: "Wrong: the guard exists." }])),
  ];
  const prior = collectDecisions(sources({ threads }));
  assert.equal(prior.entries.length, MAX_ENTRIES);
  assert.equal(prior.omitted, 5);
  assert.equal(prior.entries.filter((entry) => entry.decision === "wrong").length, 5);
  assert.deepEqual(prior.entries.map((entry) => entry.id).slice(0, 3), ["P1", "P2", "P3"]);
});

test("numbers rounds by the order of the action's reviews", () => {
  const prior = collectDecisions(sources({
    reviews: [review(7, "2026-10-03T00:00:00Z"), review(5, "2026-10-01T00:00:00Z")],
    threads: [thread(7, "Second round", [{ author: MAINTAINER, body: "Deferred to a later PR." }]), thread(5, "First round", [{ author: MAINTAINER, body: "Wrong." }])],
  }));
  assert.deepEqual(prior.entries.map((entry) => [entry.title, entry.round, entry.decision]), [["First round.", 1, "wrong"], ["Second round.", 2, "deferred"]]);
});
