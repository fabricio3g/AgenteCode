# Core tool and subagent measurements

Run `cargo run --release -p agente-core --example tool_performance` to reproduce
these local measurements. The fixture creates 6,000 source files (~25 MiB), a
small file, and a 200,000-line file in a temporary directory. Each sequential
case executes ten actual registered tool calls, reports the median and the
largest sample (nearest-rank p95), then runs eight identical concurrent searches.
No provider calls, credentials or project files are used. The OS page cache is
warm; these numbers are not cold-disk or network-model latency measurements.

Measured on this development computer, 2026-10-04:

| Case | Before median | After median | Before p95 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| Grep, no matches | 66.116 ms | 48.297 ms | 67.229 ms | 55.129 ms |
| Grep, one rare match | 66.997 ms | 50.962 ms | 68.603 ms | 53.273 ms |
| Grep, one file with context | 1.285 ms | 0.194 ms | 1.442 ms | 0.276 ms |
| Read whole small file | 1.193 ms | 0.032 ms | 1.213 ms | 0.080 ms |
| Read lines 190,000–190,100 | 17.501 ms | 7.253 ms | 18.047 ms | 10.311 ms |

Eight simultaneous searches took 95.945 ms before and 94.931 ms after. This case
varies with competing work; repeated runs ranged about 90–111 ms. An initial
four-worker implementation regressed it to 139 ms and was replaced. Directory
searches use at most two workers, with only two calls using parallel walkers
at once. Other calls use their existing blocking worker. Single-file searches
avoid worker creation. File contents are not cached, so external edits remain
visible, and `.gitignore`, symlink exclusions, scan limits and cancellation
remain enforced. Search limits count matches rather than context lines.

The largest small-tool win came from removing an awaited immediate heartbeat
tick before the tool future was first polled. The heartbeat is now scheduled
in the future, retaining liveness and cancellation without imposing a timer
wakeup on every read/search. Ranged reads use one blocking task, a 64 KiB buffer,
and a reused line string. Read-guard hashing and canonicalization happen
outside the shared map lock. Mutating tools retain their ordered path queues
and freshness checks.

The core regression runs two real child agent loops concurrently against a
scripted 150 ms provider. Each returns 450 KiB of Unicode text plus final
evidence. Both the parent tool results and forwarded display streams must be
complete and equal, with no duplicate streamed/final messages. TUI and Desktop
regressions check their own former 256 KiB and 32 KiB display cutoffs. Completed
tool output is retained; a bounded live progress preview remains a preview.
Provider output/context limits and explicit file-tool pagination are unchanged.

Validation includes the core, runtime, daemon and TUI suites, workspace checking,
renderer tests, Svelte checking, desktop builds, and real Electron smoke tests
for native browser bounds at five zoom scales, overlap/inactive tabs, isolated
conversation storage, theme/zoom reloads, resizing and sidebar interaction.

The Electron rendering fixture mounts 24 collapsed subagents with 450 KiB
answers each in about 25 ms on this machine. Opening one mounts only its own
complete reply, including the final evidence. This measures disclosure rendering,
not provider speed. The same fixture checks left-aligned prose, bounded reading
measure, and quiet inline code in both themes.
