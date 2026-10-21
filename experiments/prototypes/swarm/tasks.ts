// The swarm's task lists. Each task is a narrow brief for one cheap agent:
// chunk tasks run once for every chunk of the diff, and global passes run once
// for the whole pull request. A narrow brief with concrete steps suits a weak
// model better than the full list of review lenses.

export interface SwarmTask {
  name: string;
  /** One line that tells the agent what its part of the review is. */
  goal: string;
  /** The steps, in order. The agent reports what it checked for each. */
  steps: string[];
}

export const CHUNK_TASKS: SwarmTask[] = [
  {
    name: "callers",
    goal: "Check every place that uses what this chunk changed.",
    steps: [
      "List each function, method, class, type, constant, configuration key, route, event name, command, column or field that this chunk adds, removes, renames, or whose signature, return value, errors or meaning it changes.",
      "For each one, find every call site and other use. Start from the places listed under \"Mentions of names this chunk touches\", then search for more, including string references in configuration, tests, documentation and serialized data.",
      "Read each call site. Check that it passes the right arguments in the right order, with the right types, units and defaults.",
      "Check that each caller handles what can now come back: new return values, null or empty results, new errors or exceptions, a promise that must be awaited, a changed default.",
      "Where a changed function can produce its result along several paths, check that every path returns the same type and shape, such as an integer on one path and a float on another. Check that type annotations and docstrings say when a value can be null, empty or absent.",
      "A name the chunk removed or renamed must not still be used anywhere. Report each place that still uses the old name.",
      "Where the changed thing implements an interface, overrides a parent, or has a twin in a parallel code path, check that the other implementations were changed to match. Look for a second implementation of the same component, such as a native binding, a fallback, another backend, or a mock or test double.",
    ],
  },
  {
    name: "callees",
    goal: "Check every call this chunk makes into other code.",
    steps: [
      "List each function, method or library call that the chunk's added or changed lines make.",
      "For calls into this repository, open the definition with read_file or search. Check the argument order, types and units, and what the function does with null, empty or invalid input.",
      "Check that the chunk uses each return value correctly: an error or status that is ignored, a promise that is not awaited, a result that can be null and is used without a check, an iterator or stream that is used twice.",
      "Check whether each call can throw or fail, and whether the chunk handles that in the way the surrounding code does.",
      "Check side effects: a call that mutates a shared argument, holds a lock, opens a connection or file, or starts work that the chunk never closes, releases or waits for.",
      "For library and runtime calls, report a misuse only when you can state exactly what the function does that makes it a problem.",
    ],
  },
  {
    name: "logic",
    goal: "Check that the chunk's own logic is correct and consistent with itself.",
    steps: [
      "Read the enclosing function in full, not only the changed lines, and work out what it should do.",
      "Check each condition and comparison: inverted or wrong operators, off-by-one bounds, a check on the wrong variable, equality that compares identity where it should compare value.",
      "For each guard on input values, list the invalid inputs, such as zero, negative, a sentinel like -1, and one bad value while the others are good. Check that the guard rejects each one. Where checks sit next to each other, try a state that passes one and should fail another, such as an old or superseded record, and check whether their order changes the result.",
      "Check that every variable the chunk assigns is used. A computed limit that is never applied usually means a missing check. Also look for work done before a branch and again inside it, or done on a path that discards the result.",
      "Look for copy and paste mistakes: neighboring lines that are nearly the same but should differ, or that differ where they should be the same.",
      "Check that every branch agrees with the others: state updated on one path but not another, an early return that skips cleanup or a required step, an error that is caught and then ignored.",
      "Try the edge inputs: empty, zero, negative, null, missing, duplicate, very large, unusual characters or encodings, time zones. For values read from a file format or protocol, check what the format says zero, empty or missing mean, and whether the code treats them that way. For each early exit from a loop, check what happens when a value its condition needs is absent.",
      "Check shared state and ordering: a race between concurrent callers, a missing lock or await, work done in the wrong order.",
      "Check that names, comments and log or error messages inside the chunk say what the code does.",
    ],
  },
  {
    name: "fit",
    goal: "Check that the chunk fits the code around it and leaves nothing behind.",
    steps: [
      "Read the code around the chunk and one or two neighboring files. Note how they handle errors, logging, validation, configuration and naming.",
      "Report each place where the chunk does the same job differently from its neighbors with no stated reason, including how sibling functions store and return their results. Name the existing pattern and where it lives.",
      "When the chunk builds a configuration file, manifest or document from pieces, work out the text it will write and read it. Look for stray empty entries, wrong indentation, and blank lines the format or its linters reject.",
      "Search for an existing helper that does what the chunk writes by hand. Report code that duplicates a helper, or that is written twice within the change.",
      "Report dead code, unused variables, parameters or imports, leftover debug output, commented-out code and TODOs the change should have resolved.",
      "Report literal values that should use an existing constant or setting.",
      "Report comments, docstrings and nearby documentation that the chunk has made wrong, including text it did not edit.",
    ],
  },
  {
    name: "types",
    goal: "Check that each value the chunk returns or stores has one type and shape on every path.",
    steps: [
      "List each function the chunk adds or changes, and every way each one can end: each return statement, an implicit return at the end, an early exit, a value yielded or passed to a callback.",
      "For each way out, write down the type and shape of the value: integer or float, string or symbol, one value or a list, a pair or a single value, null, empty, or nothing.",
      "Report a function whose ways out give different types or shapes for the same meaning, at the line of the one that differs, and say what each path gives.",
      "Do the same for values the chunk stores where other code reads them, such as fields, maps, caches and files, and for sibling functions that produce the same kind of value, such as two parsers of the same field.",
      "Check that type annotations, docstrings and documentation describe what the code returns on every path, including when it can be null or empty.",
    ],
  },
];

export const GLOBAL_TASKS: SwarmTask[] = [
  {
    name: "tests",
    goal: "Check the tests the change adds or edits, and the tests it should have added.",
    steps: [
      "Open every test file the change touches and read each new or edited test in full.",
      "Report each test that cannot fail: an assertion on a value the test itself supplied, expected and actual built the same way, an assertion inside a callback that may never run, a mock that replaces the very thing under test, or no assertion at all.",
      "Report each test that checks too little: only the success path, only that nothing was thrown, only that a value exists.",
      "Report tests whose name or description does not match what they do, tests that were skipped, deleted or loosened, and tests that depend on timing, order, the network or the clock. When a test wraps other tests, open the test helper or framework and check that it supports nesting, so the wrapper is not reported as one empty passing test.",
      "List each new behavior, branch, error path and validation rule in the change. For each one with no test, report a finding on the untested code and say which case needs a test.",
      "List the input forms that the tests of neighboring features cover, such as a file path, a URL, a stream or an inline value. Report each form the new feature's tests leave out.",
    ],
  },
  {
    name: "promise",
    goal: "Check that the change does what its title and description say, and nothing else.",
    steps: [
      "List each claim the title and description make about what the change does. Compare the size of the change they describe with the size of the diff. When the diff removes features, changes public signatures or adds integrations that they do not mention, report that once, at the first line of the largest unmentioned part.",
      "For each claim, follow the code from end to end and check it is delivered: wired up, registered, exported, reachable from the layer a user calls, configured and documented. Report claims that are missing, half done or only stubbed.",
      "Report options that are parsed and then ignored, code that reports success for work it does not do, and placeholder returns.",
      "List what the change does that the description does not mention: new or changed dependencies, CI or build changes, wider permissions, changed defaults, new network calls, disabled checks, unrelated edits. Report each one the stated purpose does not need.",
    ],
  },
  {
    name: "together",
    goal: "Find the places that had to change together with this change and did not.",
    steps: [
      "List what the change adds or alters that other code must agree with: an interface, an enum or set of cases, a schema, a wire or file format, a configuration key, a command, a public function.",
      "For each one, search for its siblings: other implementations of the interface, switch statements and maps over the cases, serializers and parsers, migrations, clients, type definitions, parallel code paths such as sync and async or old and new versions.",
      "Report each sibling that the change should have updated and did not, at the sibling's own lines.",
      "Check packaging, export, registration and build lists, so new files and modules actually ship and load.",
    ],
  },
  {
    name: "docs",
    goal: "Find documentation, examples and messages that the change made wrong or should have updated.",
    steps: [
      "Search the README, guides, changelogs, examples, help text and docstrings for the names the change touches.",
      "Report each passage that now says something untrue about the code, at that passage's lines.",
      "Report a new public option, command, setting or function that lacks the documentation its neighbors have.",
      "Read each new or changed example as code a user will copy. Report examples that do needless expensive work, such as a second network request, or that use the API differently from its own documentation.",
      "Report error and log messages in the change that are misleading, and names that no longer match what the code does.",
    ],
  },
  {
    name: "risk",
    goal: "Find what could break production, leak data or weaken security when this change ships.",
    steps: [
      "Find every trust boundary the change touches: user input, network input, files, environment, other services. Check for injection, path traversal, missing validation, and missing or wrong authentication and authorization.",
      "Check for secrets, tokens or personal data written to logs, errors, URLs, caches or test fixtures, and for responses or queries that expose more than they should.",
      "Check deployment: migrations that lock or cannot roll back, new required configuration with no default, changed defaults that alter behavior for existing users.",
      "Find the oldest language, runtime and dependency versions the project says it supports, in its package manifest, its CI matrix or its README. Report new syntax or library calls that those versions do not have.",
      "Check failure handling: missing timeouts, unbounded retries, retries of work that is not idempotent, partial failure that leaves state inconsistent, leaked connections, files, locks or timers.",
      "Check performance on the changed paths: work repeated inside loops, a query per item, unbounded memory or queues, blocking calls on hot paths.",
      "For a security or data finding, name the party that gains access and say why it should not have it.",
    ],
  },
];

GLOBAL_TASKS.push(
  {
    name: "compat",
    goal: "Check the change against the oldest language, runtime and library versions the project says it supports.",
    steps: [
      "Find the oldest versions the project declares: the package manifest, such as a gemspec, package.json engines, python_requires, a go directive or a rust-version, then the CI matrix and the README. If it declares none, report nothing.",
      "Read every added line of the diff for syntax, operators, standard library calls and dependency features that the oldest declared version does not have.",
      "Check each new or upgraded dependency against those versions.",
      "Report each use at its own line. Name the feature, the version that added it, and where the project declares the older version.",
    ],
  },
  {
    name: "claims",
    goal: "Check that what the change says in text matches what its code does.",
    steps: [
      "List each statement about behavior in the changelog entries, documentation, comments, docstrings, help text and messages that the change adds or edits.",
      "For each statement, find the code that should deliver it. Check that the code does exactly that, including names, defaults, file names, aliases, commands and output.",
      "Report each statement the code does not deliver, at the statement's own lines, and say what the code does instead.",
    ],
  },
);

export const TASK_NAMES = [...CHUNK_TASKS, ...GLOBAL_TASKS].map((task) => task.name);
/** Narrow tasks that are being tried and run only when RB_CONFIG_SWARM_TASKS names them. */
export const TRIAL_TASK_NAMES = ["types", "compat", "claims"];
/** The tasks a swarm runs when RB_CONFIG_SWARM_TASKS is unset. */
export const DEFAULT_TASK_NAMES = TASK_NAMES.filter((name) => !TRIAL_TASK_NAMES.includes(name));
