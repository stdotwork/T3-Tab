/*
 * Adapted from Playwriter's `playwriter/src/diff-utils.ts`
 * (https://github.com/remorses/playwriter, revision cde94d02752cc0f5f2b9227eafddaafb9ea105b1).
 *
 * MIT License
 *
 * Copyright (c) 2026 Tommy D. Rossi
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Changes for T3-Tab: one line of context instead of three; hunks are introduced by a bare `@@`
 * instead of file headers and line ranges, and the "No newline at end of file" markers are left
 * out, to cost fewer tokens; the unused `label` option is gone.
 */
import { structuredPatch } from 'diff';

export interface SmartDiffResult {
  type: 'diff' | 'full' | 'no-change';
  content: string;
}

export interface CreateSmartDiffOptions {
  oldContent: string;
  newContent: string;
  /** Share of changed lines (0-1) from which the full new content is returned instead. Default 0.5. */
  threshold?: number;
}

/**
 * A line diff that falls back to the full new content when more than `threshold` of the lines
 * changed, or when the diff would be no shorter than the content itself.
 */
export function createSmartDiff(options: CreateSmartDiffOptions): SmartDiffResult {
  const { oldContent, newContent, threshold = 0.5 } = options;

  const patch = structuredPatch('page', 'page', oldContent, newContent, undefined, undefined, { context: 1 });

  let addedLines = 0;
  let removedLines = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) addedLines += 1;
      else if (line.startsWith('-')) removedLines += 1;
    }
  }

  if (addedLines === 0 && removedLines === 0) return { type: 'no-change', content: newContent };

  // A replaced line counts as one added and one removed, so the larger of the two is the changed share.
  const maxLines = Math.max(oldContent.split('\n').length, newContent.split('\n').length, 1);
  const changeRatio = Math.min(Math.max(addedLines, removedLines) / maxLines, 1);

  const diffLines: string[] = [];
  for (const hunk of patch.hunks) {
    diffLines.push('@@', ...hunk.lines.filter((line) => !line.startsWith('\\')));
  }
  const diffString = diffLines.join('\n');

  if (changeRatio >= threshold || diffString.length >= newContent.length) {
    return { type: 'full', content: newContent };
  }
  return { type: 'diff', content: diffString };
}
