# Repository read performance (0.4.4 work)

## Reproduction

Build, then run `node scripts/benchmark-repository.mjs <local-clone-source>`.
The script uses `git clone --no-local`, adds disposable preview files, and also
creates a separate 10,500-tracked-file repository. It never starts a provider,
changes the source repository, or leaves its fixtures/state behind. Without an
argument it runs only the synthetic fixture. Run the same script against a build
of the baseline to compare.

Measurements below use Node 22.23.2 on macOS, baseline 0.4.3 (`4829612`), and the
0.4.4 repository-read changes. The real clone has **3,673 tracked files** (the
acceptance clone had 3,631). The synthetic files live in a three-level folder.
The real deep-folder request uses the parent of a deepest tracked path. Every
operation has one cold sample and three warm samples; tables use the **warm
median**, rounded to milliseconds.

These are direct node-core request timings, not plugin paint time or network
latency. Tree pages request at most 100 entries. File previews below include
`blob` plus every `content` chunk (128 KiB each); the 1 MiB preview thus includes
eight content requests. Initial observation is reported separately. Search follows
all continuation cursors and looks for a unique marker in the new small file.

## Results

| Operation                        |                       Real clone, before |        Real clone, after |                 Synthetic 10,500 files, after |
| -------------------------------- | ---------------------------------------: | -----------------------: | --------------------------------------------: |
| Root tree page                   |                                   777 ms |                   104 ms |                                         64 ms |
| Deep-folder tree page            |                                   775 ms |                    66 ms |                                         63 ms |
| Small text preview, all bytes    |                                 1,143 ms |                   138 ms |                                        140 ms |
| 1 MiB text preview, all bytes    |                                 1,658 ms |                   610 ms |                                        667 ms |
| Content search, all cursor pages | 1,361 ms, **no match / scan incomplete** | 611 ms, **marker found** | 1,442 ms, **marker found**, two scan segments |

The synthetic baseline fails with `output_limit` before observation/browsing.
After the change, the regression test retrieves all **10,500** file entries across
byte-bounded pages and finds a marker in the final tracked file, past the old
2,048-file search cutoff.

The real search now covers all eligible files; it still explicitly reports binary
and over-1-MiB omissions. The synthetic search has no omissions after its final
cursor. The first synthetic search segment takes about 815 ms including target
validation, then provides a cursor for the remaining files instead of returning a
terminal negative answer.

| Additional real-clone measurement   |   Before |  After |
| ----------------------------------- | -------: | -----: |
| Initial observation (single sample) |   566 ms | 287 ms |
| Small-file `blob` only, warm median | 1,080 ms |  67 ms |
| 1 MiB `blob` only, warm median      | 1,079 ms |  67 ms |
| Root page, cold sample              |   799 ms | 113 ms |
| Deep-folder page, cold sample       |   761 ms |  67 ms |

Initial synthetic observation took 821 ms. Cold observations still construct an
O(repo) index, and refreshes after real filesystem/index changes rebuild it. Warm
file/tree/content reads do not enumerate tracked paths, run whole-tree status, or
rebuild snapshots. Unsupported/failed recursive watching takes a conservative
validation route rather than serving unchecked cache hits.

## Causes and changes

- Working reads previously rebuilt status, tracked/untracked paths and all file
  metadata several times per request. A shared per-worktree/HEAD/index/filesystem
  snapshot now provides O(1) path lookup and pre-sorted per-directory pages.
  Requested item metadata and pinned descriptor reads fence same-path changes;
  HEAD/index/refs and recursive filesystem generations invalidate old revisions.
- Lease pruning also serialized full snapshots/cursor rows on every read/page.
  Shared arrays now have cached size accounting, so paging does not reserialize
  the repository just to enforce the existing memory bounds.
- The 512 KiB Git ceiling rejected normal large indexes before pagination could
  help. Tracked/untracked paths now stream as NUL-delimited UTF-8 records under a
  separate 64 MiB ceiling. Index cache footprint and path count remain bounded;
  response pages retain the existing 32 KiB envelope limit.
- Search had a terminal 2,048-file cutoff. It now checkpoints remaining files at
  time/byte budgets and resumes through existing v1 cursors, including empty
  result pages. Hostile regex execution also returns a typed incomplete deadline
  before the client's five-second timeout: the regression failed at 5,068 ms
  before the one-second worker segment deadline was added.
- Historical macOS FSEvents and Git lockfile/submodule noise must not invalidate a
  just-captured revision. Metadata-equivalent/pre-capture hints are filtered;
  actual item replacements still invalidate. macOS root-self basename hints are
  normalized without hiding deletion of a real same-named child. Submodule contents
  remain excluded.

## Review follow-up: ignore dependencies and shared-index admission

The review reproduced omitted custom/external ignore dependencies and a phantom
revision on a real 75,000-short-path fixture. Shared index arrays had been charged
against the smaller lease budget; both observation and directory cursors could be
evicted at insertion. Index memory is now charged once, including lease-retained
old indexes, and new admissions are protected from their own eviction. Genuine
capacity failures return a limit error before publishing an observation/cursor ID.
The 75k regression checks fresh/repeated observations, tree continuation, file reads,
and eviction between normal/include-ignored visibility variants.

Exclude dependency tests suppress filesystem delivery deliberately. They cover
custom relative/external/tilde/symlinked sources, default XDG ignore, root/nested
ignore files, standard info/exclude, worktree configuration, included/missing
configuration, and onbranch conditional includes. Additional failing regressions
caught ignore edits during path capture and a fresh-observation tracked-edit gap.
Explicit fresh observations reconcile known metadata; item reads still never
rebuild/enumerate the repository. Status/search results also fence returned paths.

A post-review rerun on Node 22.23.2/macOS used a new real clone with **3,671 tracked
files** (different source HEAD from the original baseline). Warm medians:

| Operation                |             Real clone |  Synthetic 10,500 files |
| ------------------------ | ---------------------: | ----------------------: |
| Root page                |                  61 ms |                   56 ms |
| Deep-folder page         |                  59 ms |                   68 ms |
| Small preview, all bytes |                 135 ms |                  153 ms |
| 1 MiB preview, all bytes |                 584 ms |                  533 ms |
| Complete search          | 1,436 ms, two segments | 4,026 ms, five segments |

Rule signatures add scan overhead; search remains time-bounded and resumable.
Individual search segments take about 811–820 ms including validation, still well
below the client timeout. Both searches find the marker; the real scan explicitly
skips binary files, and the synthetic final page has no omissions. Initial
observations took 466/802 ms respectively. No before/after claim is made for the
changed real source HEAD.

The follow-up native related run passes **117 tests** with two workers. The Linux
Node 22 full check passes **1,040 tests**, with three existing expected failures and
one skipped test, plus build/types/format checks; disposable VM files are removed.
ESLint is unavailable as a project check because the repository has no configuration.

## Verification and limits

Failing regressions preceded the fixes: per-read Git-enumeration counting,
10,500-file admission, and hostile-regex response latency. Native related tests
use at most two workers; Linux full build/types/tests/format checks use a disposable
VM source directory and Node 22. No live provider, Obsidian vault, test device,
installer, service or deployed node was used.

Two existing ceiling tests were updated, not removed: the huge-tree test still
asserts `output_limit` with an explicitly small configured metadata ceiling and
also asserts bounded normal browsing; the old file-count cutoff test now asserts
time-budget exhaustion, incomplete coverage, a continuation cursor, and discovery
beyond file 2,048. The byte-budget and per-file match truncation guarantees remain.

Repository wire schemas are unchanged. Frozen 0.4.2 discovery/handshake decoders
and repository client/daemon tests pass. Actual plugin 2.5.2 rendering, recursive
client refresh amplification, and browsing-related channel liveness still need
end-to-end acceptance; these timings do not claim those plugin issues are fixed.
Working observations remain explicitly non-atomic, with asynchronous filesystem
hints and synchronous checks of requested items, not an atomic repository snapshot.
