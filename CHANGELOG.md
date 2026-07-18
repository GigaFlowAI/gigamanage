# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org): while
0.x, a **minor** bump means behavior changed in a way you should read about before
upgrading, and a **patch** is a fix that asks nothing of you.

## 0.6.1

### The chat/summary split is coloured now

The picker's preview pane rendered monochrome — its stdout is a pipe, so gm's
colour gated itself off, and even the `── ask ──` divider between the session
card and the chat came out plain. fzf paints the preview with `--ansi`, though,
so the seam can carry colour: the divider is now **cyan** (gm's own accent) and
the `you` / `gm` speaker labels light up, while the card stays monochrome.

It's an accent, not the message — the divider's glyphs and the speakers' layout
still carry the structure, so `NO_COLOR` and `TERM=dumb` lose only the colour.
`gm ls` and `gm show` are unchanged and still pipe clean.

## 0.6.0

**Upgrading:** `ctrl-o` in the picker no longer suspends the list. It opens the
chat in the preview pane instead, so the session you were reading stays on
screen. Nothing else changes for you: bare `gm ask`, the `--json` form, and the
`fzf < 0.46` and no-fzf fallbacks all behave exactly as before.

### ctrl-o asks in the pane, not over the list

`ctrl-o` used to suspend fzf and hand the child a full-screen REPL — so the first
thing it did was take away the very session you pressed it *to ask about*.
Browsing and asking are the same activity, and that made them mutually exclusive.

Now `ctrl-o` is a **mode**, not a launch. The list stays put, the card moves to
the top of the preview pane, and the answer arrives underneath it while you keep
arrowing around. It's **one continuous thread**: moving the cursor re-points
"this session" without forking or resetting what you've asked. `esc` leaves chat
and hands back the list exactly where you were.

`claude -p` buffers rather than streams, so there is no answer to render word by
word — instead a **1-second heartbeat** shows `thinking… 14s` while the request
is in flight, then the answer lands in one paint. The picker never freezes, and
`esc` cancels a request mid-answer.

Nothing regresses for people who never ask: with no conversation yet, the card
gets the full pane exactly as today. `fzf < 0.46` keeps the full-screen `execute`
REPL, and the no-fzf numbered list keeps its `a` key.

### Fixes

- The orphan-transcript sweep is now keyed on the **run**, not the transcript. A
  picker killed between `ctrl-o` and the first question leaves a `.browseq` with
  no `.jsonl` beside it; keyed on the transcript, the sweep could never see that
  run, so the cache grew one file per killed picker. It now reaps every member of
  a dead run.
- Multi-byte output from providers is no longer mangled at chunk boundaries, and
  callers can watch a request as it streams.

## 0.5.0

**Upgrading:** the first time you run `gm` in a terminal, it will ask you to
choose a harness before doing any model work. Nothing prompts when the output
isn't a terminal, and `GIGAMANAGE_SUMMARY_CMD` still overrides everything — so
scripts, CI and agents are unaffected.

### gm asks who to call, once, instead of assuming

The first time you run `gm` in a terminal it asks which harness should do its
model work — Claude Code, Codex, any command that reads a prompt on stdin, or
nothing at all. Before, it assumed `claude -p` and started spending tokens in the
background without ever mentioning it.

Your answer lives in `~/.config/gigamanage/config.json`, and `gm setup` changes
it. Choosing **nothing** is a real answer: `gm ls` and `gm show` still work on
hard facts alone, and nothing calls a model.

Nothing prompts unless there's a human at the other end. No TTY, `--json`, or an
internal command means gm behaves exactly as it did before: autodetect and carry
on. `GIGAMANAGE_SUMMARY_CMD` still overrides everything, so existing scripts and
CI need no changes.

### gm ask

`gm ls` answers "what was I doing?" one row at a time. **`gm ask`** answers the
question that spans them:

```bash
gm ask "what's still broken?"
gm ask "what did I already try for the retry?" --json
```

It starts from the summaries already on disk, so a question costs one model call
rather than a scan of your transcripts. When the summaries aren't enough it runs
`gm grep` against the real thing and reads what you actually said.

**In the picker, `ctrl-o`** opens it on the session you're highlighting and drops
you back in the list, right where you were, when you're done. Without fzf, the
numbered list spells it `a`.

Not `shift+f`: fzf's query line eats plain letters, so `F` would just type an
`F`. Not `alt-a` either — macOS Terminal and iTerm2 send `å`.

### The picker explains its markers

`gm ls` printed a key for `⚠`, `◐` and `○`. The picker — bare `gm` — rendered the
same three markers and explained none of them, which put the explanation exactly
where you needed it least: `ls` is the command you run to read a list, and the
picker is the one you run to *choose*. `⚠` is the whole point of the tool, and in
the picker it was an unexplained glyph.

Both picker paths now carry a key: a second header line under fzf, and a line
above the "install fzf" hint in the numbered fallback.

It is deliberately static — every marker, always, and never a count — while
`gm ls` keeps its counted one. fzf sets its header once, at spawn; ctrl-r
replaces the list and leaves the header alone. Counts there would freeze at open
and be wrong after the first refresh, which is precisely when they change. A key
that is stale exactly when it matters is worse than no key at all.

## 0.4.0

### ctrl-r refreshes the picker

The picker used to be a dead end: the list it opened with was the list you were
stuck with. Sessions you started since never appeared, and rows marked `○` stayed
`○` however long you sat there.

**ctrl-r** now reloads to your most recent sessions and starts summaries for any
that need one, without leaving the picker — so it's something you can navigate in
while an agent works alongside you. Without fzf, the numbered list takes `r` for
the same thing.

Repeated presses are safe. The lock that already stopped five `gm ls` from
starting five summarizers stops this too: a press while a pass is running just
reloads. Sessions whose summary is already current are never rewritten, so ctrl-r
on a fresh list costs nothing.

### Bare `gm` summarizes what it shows

Only `gm ls` kicked off a background pass; the picker never did. It does now,
over the sessions it is about to offer, and rows being written are marked `◐`
there as well as in `gm ls`.

### Fixed: `--no-auto-summarize` never worked

`gm --no-auto-summarize ls` spent tokens anyway. The flag is declared on the root
command, and commander does not copy root options into a subcommand's own
options — so the check read `undefined`, compared it against `false`, and
concluded you wanted summaries. Only `GIGAMANAGE_AUTO_SUMMARIZE=0` actually
turned them off.

The flag now works, on `gm ls` and in the picker, and it is carried across to the
process ctrl-r starts.

### Shorter headlines

Row headlines asked the model for "max 80 chars" and then rendered them in a
72-char column — an overflow by construction, read as a truncated sentence. They
are now one scannable clause, sized to the column they live in.

The summary cache key covers the prompt as well as the session, so this reaches
summaries already on disk: they regenerate in the background on first run rather
than keeping their old headlines forever. That costs a pass of model calls once.
`GIGAMANAGE_AUTO_SUMMARIZE=0` still opts out of all of it.

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
