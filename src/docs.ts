// Picks the documents most likely to describe the design and rules of the area a change touches.

const MAX_DOCUMENTS = 30;
const DOCUMENT = /\.(md|mdx|rst|adoc|txt)$/i;
const ROOT_DOCUMENT = /^(readme|architecture|design|security|contributing|charter)(\.[a-z]+)?$/i;
const NESTED_DOCUMENT = /^(readme|agents|claude|architecture|design)\.md$/i;
const DESIGN_DIRECTORY = /(^|\/)(design|designs|adr|adrs|architecture|rfc|rfcs|spec|specs|decisions)\//i;
/** Design directories deeper than this are usually vendored or generated. */
const MAX_DESIGN_DEPTH = 5;
const OWNERS = /^(\.github\/|docs\/)?CODEOWNERS$/;

function ancestors(file: string): string[] {
  const parts = file.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

/**
 * Returns paths worth offering to the reviewer, most specific first:
 * documents beside the changed code, then design directories, then root documents.
 * `skip` lists files whose text the reviewer is already given.
 */
export function pickDesignDocs(files: string[], changedFiles: string[], skip: string[]): string[] {
  const touched = new Set(changedFiles.flatMap(ancestors));
  const skipped = new Set(skip);
  const nearby: string[] = [];
  const design: string[] = [];
  const root: string[] = [];
  for (const file of files) {
    if (skipped.has(file)) continue;
    const slash = file.lastIndexOf("/");
    const directory = slash === -1 ? "" : file.slice(0, slash);
    const name = file.slice(slash + 1);
    if (directory === "") {
      if (ROOT_DOCUMENT.test(name)) root.push(file);
    } else if (OWNERS.test(file)) {
      root.push(file);
    } else if (touched.has(directory) && NESTED_DOCUMENT.test(name)) {
      nearby.push(file);
    } else if (DOCUMENT.test(name) && DESIGN_DIRECTORY.test(file) && file.split("/").length <= MAX_DESIGN_DEPTH) {
      design.push(file);
    }
  }
  // Deeper nearby documents are closer to the changed code.
  nearby.sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));
  return [...nearby, ...design, ...root].slice(0, MAX_DOCUMENTS);
}
