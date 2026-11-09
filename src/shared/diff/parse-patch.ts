/**
 * Parses one file's unified patch, as `git diff` writes it, into structured hunks.
 *
 * The input is the patch of a single file. Parsing stops at a second `diff --git` header,
 * so anything after it is ignored. Paths are read with Git's default `a/` and `b/`
 * prefixes; C-quoted paths are unquoted whether or not `core.quotePath` is set.
 */

import type { DiffStats, Hunk, HunkLine } from "../domain/diff";

/** What the patch does to the file, as its headers say. */
export type PatchOperation = "modified" | "added" | "deleted" | "renamed" | "copied";

export interface ParsedPatch {
  /** Complete hunks only; a hunk cut off before its header's line counts is dropped. */
  hunks: Hunk[];
  /** Lines added and removed across `hunks`. */
  stats: DiffStats;
  /** Git reported `Binary files … differ` or a `GIT binary patch`. */
  binary: boolean;
  /** Path on the left side; absent when that side is `/dev/null` (an added file). */
  oldPath?: string;
  /** Path on the right side; absent when that side is `/dev/null` (a deleted file). */
  newPath?: string;
  /** Left file mode, such as `100644`, when the headers give it. */
  oldMode?: string;
  /** Right file mode, such as `100755`, when the headers give it. */
  newMode?: string;
  /** `similarity index` percentage of a rename or copy. */
  similarity?: number;
  operation: PatchOperation;
  /**
   * The patch is incomplete: the caller said the input was cut off, or the last hunk ended
   * before its header's line counts were reached (and was dropped).
   */
  truncated: boolean;
}

export interface ParsePatchOptions {
  /**
   * The input was cut off (for example at the patch size limit). Its last line is treated
   * as partial and dropped unless the input ends with a line feed, and the result is marked
   * truncated.
   */
  truncated?: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const SIMILARITY = /^similarity index (\d+)%/;
const INDEX_MODE = /^index [^ ]+\.\.[^ ]+ (\d+)$/;
const DEV_NULL = "/dev/null";

interface OpenHunk {
  hunk: Hunk;
  oldLeft: number;
  newLeft: number;
  oldNo: number;
  newNo: number;
}

interface Header {
  sawGitHeader: boolean;
  oldPath: string | undefined;
  newPath: string | undefined;
  oldAbsent: boolean;
  newAbsent: boolean;
  oldMode: string | undefined;
  newMode: string | undefined;
  similarity: number | undefined;
  operation: PatchOperation;
  binary: boolean;
}

export function parsePatch(patch: string, options: ParsePatchOptions = {}): ParsedPatch {
  const lines = splitLines(patch, options.truncated === true);
  const header: Header = {
    sawGitHeader: false,
    oldPath: undefined,
    newPath: undefined,
    oldAbsent: false,
    newAbsent: false,
    oldMode: undefined,
    newMode: undefined,
    similarity: undefined,
    operation: "modified",
    binary: false,
  };
  const hunks: Hunk[] = [];
  let truncated = options.truncated === true;
  let open: OpenHunk | null = null;
  let inHunks = false;

  for (const line of lines) {
    if (open !== null) {
      if (consumeHunkLine(open, line)) continue;
      if (isComplete(open)) hunks.push(open.hunk);
      else truncated = true;
      open = null;
    }

    if (line.startsWith("@@")) {
      const hunk = parseHunkHeader(line);
      if (hunk !== null) {
        open = hunk;
        inHunks = true;
      }
      continue;
    }
    if (line.startsWith("diff --git ")) {
      if (header.sawGitHeader || inHunks) break;
      header.sawGitHeader = true;
      const paths = parseGitHeaderPaths(line.slice("diff --git ".length));
      header.oldPath = paths.oldPath;
      header.newPath = paths.newPath;
      continue;
    }
    if (!inHunks) readExtendedHeader(header, line);
  }

  if (open !== null) {
    if (isComplete(open)) hunks.push(open.hunk);
    else truncated = true;
  }

  return buildResult(header, hunks, truncated);
}

/**
 * Splits on LF only, so the CR of a CRLF content line stays in that line. The piece after
 * the last LF is empty for complete input; for cut-off input it is a partial line.
 */
function splitLines(patch: string, cutOff: boolean): string[] {
  if (patch === "") return [];
  const lines = patch.split("\n");
  const last = lines.pop();
  if (last !== undefined && last !== "" && !cutOff) lines.push(last);
  return lines;
}

function parseHunkHeader(line: string): OpenHunk | null {
  const match = HUNK_HEADER.exec(line);
  if (match === null) return null;
  const oldStart = Number(match[1]);
  const oldLines = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newLines = match[4] === undefined ? 1 : Number(match[4]);
  return {
    hunk: { oldStart, oldLines, newStart, newLines, header: line, lines: [] },
    oldLeft: oldLines,
    newLeft: newLines,
    oldNo: oldStart,
    newNo: newStart,
  };
}

function isComplete(open: OpenHunk): boolean {
  return open.oldLeft === 0 && open.newLeft === 0;
}

/**
 * Adds `line` to the open hunk when it belongs there. A content line belongs only while
 * the header's counts allow it; a `\ No newline at end of file` marker always does.
 */
function consumeHunkLine(open: OpenHunk, line: string): boolean {
  const marker = line.charAt(0);
  let entry: HunkLine;
  if (marker === "\\") {
    const text = line.startsWith("\\ ") ? line.slice(2) : line.slice(1);
    entry = { kind: "noNewline", text, oldNo: null, newNo: null };
  } else if (marker === " " || line === "") {
    // An empty line is a context line whose single space was stripped by some tool.
    if (open.oldLeft === 0 || open.newLeft === 0) return false;
    entry = { kind: "context", text: line.slice(1), oldNo: open.oldNo, newNo: open.newNo };
    open.oldNo += 1;
    open.newNo += 1;
    open.oldLeft -= 1;
    open.newLeft -= 1;
  } else if (marker === "-") {
    if (open.oldLeft === 0) return false;
    entry = { kind: "remove", text: line.slice(1), oldNo: open.oldNo, newNo: null };
    open.oldNo += 1;
    open.oldLeft -= 1;
  } else if (marker === "+") {
    if (open.newLeft === 0) return false;
    entry = { kind: "add", text: line.slice(1), oldNo: null, newNo: open.newNo };
    open.newNo += 1;
    open.newLeft -= 1;
  } else {
    return false;
  }
  open.hunk.lines.push(entry);
  return true;
}

function readExtendedHeader(header: Header, line: string): void {
  if (line.startsWith("--- ")) {
    const path = readHeaderPath(line.slice(4));
    if (path === DEV_NULL) header.oldAbsent = true;
    else header.oldPath = stripPrefix(path, "a/");
  } else if (line.startsWith("+++ ")) {
    const path = readHeaderPath(line.slice(4));
    if (path === DEV_NULL) header.newAbsent = true;
    else header.newPath = stripPrefix(path, "b/");
  } else if (line.startsWith("old mode ")) {
    header.oldMode = line.slice("old mode ".length);
  } else if (line.startsWith("new mode ")) {
    header.newMode = line.slice("new mode ".length);
  } else if (line.startsWith("new file mode ")) {
    header.newMode = line.slice("new file mode ".length);
    header.oldAbsent = true;
    header.operation = "added";
  } else if (line.startsWith("deleted file mode ")) {
    header.oldMode = line.slice("deleted file mode ".length);
    header.newAbsent = true;
    header.operation = "deleted";
  } else if (line.startsWith("rename from ")) {
    header.oldPath = readPath(line.slice("rename from ".length));
    header.operation = "renamed";
  } else if (line.startsWith("rename to ")) {
    header.newPath = readPath(line.slice("rename to ".length));
    header.operation = "renamed";
  } else if (line.startsWith("copy from ")) {
    header.oldPath = readPath(line.slice("copy from ".length));
    header.operation = "copied";
  } else if (line.startsWith("copy to ")) {
    header.newPath = readPath(line.slice("copy to ".length));
    header.operation = "copied";
  } else if (line.startsWith("similarity index ")) {
    const match = SIMILARITY.exec(line);
    if (match !== null) header.similarity = Number(match[1]);
  } else if (line.startsWith("index ")) {
    // `index <old>..<new> <mode>` carries the mode only when it did not change.
    const match = INDEX_MODE.exec(line);
    if (match?.[1] !== undefined) {
      header.oldMode ??= match[1];
      header.newMode ??= match[1];
    }
  } else if (
    line === "GIT binary patch" ||
    (line.startsWith("Binary files ") && line.endsWith(" differ"))
  ) {
    header.binary = true;
  }
}

function buildResult(header: Header, hunks: Hunk[], truncated: boolean): ParsedPatch {
  let operation = header.operation;
  if (operation === "modified" && header.oldAbsent) operation = "added";
  else if (operation === "modified" && header.newAbsent) operation = "deleted";

  const stats: DiffStats = { added: 0, removed: 0 };
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") stats.added += 1;
      else if (line.kind === "remove") stats.removed += 1;
    }
  }

  const result: ParsedPatch = { hunks, stats, binary: header.binary, operation, truncated };
  if (!header.oldAbsent && header.oldPath !== undefined) result.oldPath = header.oldPath;
  if (!header.newAbsent && header.newPath !== undefined) result.newPath = header.newPath;
  if (header.oldMode !== undefined) result.oldMode = header.oldMode;
  if (header.newMode !== undefined) result.newMode = header.newMode;
  if (header.similarity !== undefined) result.similarity = header.similarity;
  return result;
}

function stripPrefix(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** A path from a `rename`/`copy` header: quoted, or verbatim to the end of the line. */
function readPath(text: string): string {
  if (text.startsWith('"')) {
    const quoted = readQuoted(text, 0);
    if (quoted !== null) return quoted.value;
  }
  return text;
}

/**
 * A path from a `---`/`+++` line. An unquoted Git path never holds a raw tab (a tab forces
 * quoting), so anything from the first tab on is dropped: Git adds one after a name that
 * contains a space, and other tools put a timestamp there.
 */
function readHeaderPath(text: string): string {
  if (text.startsWith('"')) {
    const quoted = readQuoted(text, 0);
    if (quoted !== null) return quoted.value;
  }
  const tab = text.indexOf("\t");
  return tab === -1 ? text : text.slice(0, tab);
}

/**
 * The two paths of a `diff --git a/<old> b/<new>` line, without their prefixes. Unquoted
 * paths that contain spaces are ambiguous here; for an unrenamed file the line is split
 * where both halves name the same path, as `git apply` does. Rename, copy and `---`/`+++`
 * headers, when present, override what is read here.
 */
function parseGitHeaderPaths(rest: string): { oldPath?: string; newPath?: string } {
  let oldPart: string | undefined;
  let newPart: string | undefined;

  if (rest.startsWith('"')) {
    const first = readQuoted(rest, 0);
    if (first === null) return {};
    oldPart = first.value;
    const remainder = rest.slice(first.end).replace(/^ /, "");
    newPart = readPath(remainder);
  } else {
    // An unquoted path holds no `"` (it would force quoting), so ` "` starts a quoted b-path.
    const quotedNew = rest.indexOf(' "');
    if (quotedNew !== -1) {
      oldPart = rest.slice(0, quotedNew);
      newPart = readPath(rest.slice(quotedNew + 1));
    } else {
      const split = splitSymmetric(rest) ?? splitAtFirst(rest);
      if (split === null) return {};
      [oldPart, newPart] = split;
    }
  }

  return { oldPath: stripPrefix(oldPart, "a/"), newPath: stripPrefix(newPart, "b/") };
}

/** Splits `a/<path> b/<path>` where both halves name the same path. */
function splitSymmetric(rest: string): [string, string] | null {
  if (rest.length % 2 === 0) return null;
  const middle = (rest.length - 1) / 2;
  if (rest.charAt(middle) !== " ") return null;
  const oldPart = rest.slice(0, middle);
  const newPart = rest.slice(middle + 1);
  if (stripPrefix(oldPart, "a/") !== stripPrefix(newPart, "b/")) return null;
  return [oldPart, newPart];
}

function splitAtFirst(rest: string): [string, string] | null {
  const at = rest.indexOf(" b/");
  if (at !== -1) return [rest.slice(0, at), rest.slice(at + 1)];
  const space = rest.indexOf(" ");
  if (space === -1) return null;
  return [rest.slice(0, space), rest.slice(space + 1)];
}

const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  "\\": 0x5c,
};

/**
 * Reads the C-quoted string that starts at `text[start]` (a `"`), as Git quotes paths.
 * Octal escapes are UTF-8 bytes. Returns the value and the index after the closing quote,
 * or `null` when the string is not terminated.
 */
function readQuoted(text: string, start: number): { value: string; end: number } | null {
  let value = "";
  let bytes: number[] = [];
  const flush = (): void => {
    if (bytes.length > 0) {
      value += decodeUtf8(bytes);
      bytes = [];
    }
  };

  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '"') {
      flush();
      return { value, end: i + 1 };
    }
    if (ch === "\\") {
      const octal = text.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(Number.parseInt(octal, 8));
        i += 3;
        continue;
      }
      const escaped = C_ESCAPES[text.charAt(i + 1)];
      if (escaped !== undefined) {
        bytes.push(escaped);
        i += 1;
        continue;
      }
    }
    flush();
    value += ch;
  }
  return null;
}

/** Decodes UTF-8 bytes without `TextDecoder`, which `src/shared` cannot assume. */
function decodeUtf8(bytes: readonly number[]): string {
  const percentEncoded = bytes.map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
  try {
    return decodeURIComponent(percentEncoded);
  } catch {
    // Not valid UTF-8: keep each byte as one character.
    return String.fromCharCode(...bytes);
  }
}
