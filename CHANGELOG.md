# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org): while
0.x, a **minor** bump means behavior changed in a way you should read about before
upgrading, and a **patch** is a fix that asks nothing of you.

## 0.3.0

### Summaries keep up with what you actually look at

The background pass used to cover a fixed **10** sessions while `gm ls` displayed
**20** — so the bottom half of the default view was permanently marked "no summary
yet", and the feature looked broken even though it was working exactly as built.

The window now follows the list: `gm ls` keeps 20 summarized, `gm ls -n 50` keeps
all fifty. Summaries are written **8 at a time** in parallel (tune with
`GIGAMANAGE_SUMMARY_CONCURRENCY`), and a single pass writes at most 50, saying so
rather than truncating in silence.

### You can see it working

Rows being summarized *right now* are marked `◐`, distinct from `○` ("no summary
yet, nothing running"). The decision is made before the list renders, so the icon
is true on the very run that starts the work.

### Background failures are no longer silent

The worker's stdio is discarded, so a broken provider used to mean summaries
simply never appeared, with nothing to look at. Failures now land in
`~/.cache/gigamanage/auto-summarize.log`, and `gm doctor` surfaces the last one.

**Fixed:** the worker could silently write **zero** summaries. It resolved its
queue by loading "the N most recent sessions" and filtering — but with sidechains
included, the most recent N are mostly subagent transcripts, so the filter matched
nothing. It now looks the queued sessions up across the whole store.

### The picker wraps too

fzf rows no longer truncate: a session is one NUL-delimited multi-line record
(`--read0`), so a long summary wraps and is still selected as a single item. fzf
below 0.46 has no multi-line display, so it falls back to single-line rows rather
than rendering one session as several bogus entries. The numbered fallback (no fzf
installed) wraps as well.

## 0.2.0

**gigamanage now spends tokens on your behalf unless you tell it not to.** That is a
change of default behavior, which is why this is a minor bump rather than a patch —
everything in it already shipped as 0.1.3/0.1.4, but the version number was
under-selling it.

### Summaries write themselves

Any `gm` command now checks the 10 most recent sessions and, if any lack a current
summary, writes them in a **detached background process**. The foreground command
never waits on a model: it prints, tells you on stderr what it started, and exits.
Summaries appear on your next run. Rows still waiting are marked `○`.

Three things this deliberately does not do:

- **Block.** A summary costs ~8s of model time. Ten of those inline would turn a
  60ms `gm ls` into a minute of waiting.
- **Stampede.** A lock in `~/.cache/gigamanage` means five `gm ls` in a row start
  one summarizer, not five.
- **Loop.** The summarizer *is* `claude -p`, which writes a session of its own.
  Automated runs and sidechains are excluded from the target set, so gigamanage
  cannot summarize its own summarizer forever.

**Turning it off**, because background model calls cost money:

```bash
gm --no-auto-summarize ls          # once
export GIGAMANAGE_AUTO_SUMMARIZE=0 # for good
```

It also stays quiet when no summary provider is installed — a missing `claude`
never breaks a read command. `gm doctor` reports the current state.

### `gm ls` wraps instead of truncating

Long descriptions were cut off at 72 characters, so the sessions with the most
informative summaries were exactly the ones you could not read. They now wrap to the
terminal, with continuation lines indented under the description column.

Piped output still emits **one line per session**, untruncated, so `gm ls | grep`
behaves. The fzf picker's rows stay single-line, because fzf maps lines back to
session ids.

## 0.1.2

- `gm --version` reported a hardcoded `0.1.0` regardless of the installed version.
  It now reads `package.json`.

## 0.1.1

- First release published through [trusted publishing](https://docs.npmjs.com/trusted-publishers/)
  (OIDC): no long-lived npm token, and every release carries a provenance
  attestation binding the package to the commit and workflow that built it.

## 0.1.0

First release.

- Index sessions from **Claude Code** and **Codex**; one adapter per harness, and
  adding another is a single file.
- Summaries describe where a session **landed**, not where it started — built from
  the *tail* of each transcript, because a harness's own title is written in the
  first few seconds and never revised.
- Sessions that ended mid-task are flagged `⚠`.
- `gm resume` hands off to the right CLI (`claude --resume` / `codex resume`) in the
  session's original directory.
- `--json` on every read command, so agents can call it too.
- Read-only: never writes to a session file.
