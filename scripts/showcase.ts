// The showcase deck: a restart-race fix in the sample repo, told the way
// the authoring guide recommends. Shared by the demo and the video recorder.
type Git = { repo: string; base: string; head: string }

export const deck = {
  title: 'Retry the bind instead of waiting',
  repo: 'acme/beacon',
  ref: 'PR #482 · fix/bind-retry',
  theme: 'midnight',
}

export const slides = (git: Git) => [
  {
    type: 'title',
    title: 'Retry the bind instead of *waiting*',
    subtitle: 'A restarted daemon no longer waits 15 seconds for an incumbent that is already gone — it simply tries the port again.',
    meta: { Author: 'Ana Ruiz', Branch: 'fix/bind-retry', Reviewers: '@maya · @sam' },
    git,
    notes: 'Thirty-second version: restarts used to fail because the new daemon waited for the wrong thing.',
  },
  {
    type: 'points',
    kicker: 'Overview',
    title: 'Three changes, one *fewer* failure mode',
    points: [
      { title: 'Restarts no longer fail', body: 'The new daemon retries `bind` every 100 ms instead of waiting 15 s for a registration.', tag: 'fix' },
      { title: 'One loop, one deadline', body: '`waitForIncumbent` is gone — `bind` owns the retry, the liveness check and the timeout.', tag: 'refactor' },
      { title: 'Covered by two tests', body: 'Port hand-off completes under a second, and a live server is still never replaced.', tag: 'test' },
    ],
  },
  {
    type: 'files',
    kicker: 'Scope',
    title: 'Small, and contained to the *server*',
    git,
    groups: [
      { title: 'The fix', note: '`bind.ts` gains the retry loop; `registry.ts` loses the helper it no longer needs.', paths: ['src/server/'] },
      { title: 'The proof', note: 'A new test file exercises the hand-off and the guard against live servers.', paths: ['test/'] },
    ],
  },
  { type: 'section', title: 'The restart *race*', subtitle: 'What a restart looked like before, and what it looks like now.' },
  {
    type: 'sequence',
    kicker: 'Behavior',
    title: 'The new daemon waited for someone who was *leaving*',
    participants: [
      { id: 'cli', label: 'beacon restart', detail: 'CLI', icon: 'terminal' },
      { id: 'old', label: 'Old daemon', detail: 'pid 812', icon: 'server' },
      { id: 'new', label: 'New daemon', detail: 'pid 977', icon: 'server' },
      { id: 'port', label: 'Port', detail: ':4747', icon: 'plug' },
    ],
    phases: [
      {
        title: 'Before',
        note: 'A restart signals the old daemon and immediately spawns a new one.',
        rows: [
          { from: 'cli', to: 'old', label: 'SIGTERM' },
          { from: 'cli', to: 'new', label: 'spawn', with_previous: true },
          { from: 'new', to: 'port', label: 'bind :4747', aside: 'EADDRINUSE — old daemon still exiting', tone: 'error', caption: 'The new daemon races the old one for the port and loses by a few milliseconds.' },
          { from: 'old', to: 'port', label: 'close()', kind: 'reply', caption: 'The old daemon exits and frees the port almost immediately…' },
          { from: 'new', to: 'new', label: 'waitForIncumbent(15s)', tone: 'warning', caption: '…but the new daemon is waiting for an incumbent to *register*, and it never will.' },
          { from: 'new', to: 'cli', label: 'port stayed busy for 15s', kind: 'reply', tone: 'error', caption: 'Fifteen seconds later it gives up, on a port that has been free the whole time.' },
        ],
      },
      {
        title: 'After',
        note: 'Same restart, same race.',
        rows: [
          { from: 'cli', to: 'old', label: 'SIGTERM' },
          { from: 'cli', to: 'new', label: 'spawn', with_previous: true },
          { from: 'new', to: 'port', label: 'bind :4747', aside: 'EADDRINUSE — retry in 100 ms', tone: 'warning', caption: 'The first bind still loses the race. That is fine now.' },
          { from: 'new', to: 'new', label: 'readRegistration()', aside: 'no live incumbent', caption: 'Instead of waiting, it checks once: is a *live* server registered? No.' },
          { from: 'old', to: 'port', label: 'close()', kind: 'reply' },
          { from: 'new', to: 'port', label: 'bind :4747', tone: 'success', caption: 'Within ~100 ms of the port freeing up, the same process takes it.' },
          { from: 'new', to: 'cli', label: 'ready in 142 ms', kind: 'reply', tone: 'success' },
        ],
      },
    ],
  },
  {
    type: 'flow',
    kicker: 'Architecture',
    title: 'Every client depends on *one* daemon',
    nodes: [
      { id: 'term', label: 'Terminals', detail: 'beacon CLI', icon: 'terminal', at: [0, 0] },
      { id: 'app', label: 'Desktop app', detail: 'Electron', icon: 'monitor', at: [0, 2] },
      { id: 'daemon', label: 'beacon daemon', detail: 'pid 977', icon: 'server', at: [1, 1] },
      { id: 'reg', label: 'Registration', detail: '~/.beacon/4747.json', icon: 'file', at: [2, 0], shape: 'store' },
      { id: 'port', label: 'TCP port', detail: ':4747', icon: 'plug', at: [2, 2], shape: 'pill' },
    ],
    edges: [
      { from: 'term', to: 'daemon', label: 'requests' },
      { from: 'app', to: 'daemon', label: 'requests' },
      { from: 'daemon', to: 'reg', label: 'pid', dashed: true },
      { from: 'daemon', to: 'port', label: 'listen' },
    ],
    steps: [
      { title: 'One daemon, many clients', note: 'Every terminal and the desktop app talk to the same background daemon.', packets: [{ from: 'term', to: 'daemon' }, { from: 'app', to: 'daemon' }] },
      { title: 'A failed restart takes everyone down', note: 'When the restart fails, **every** client loses its connection — not just the terminal that asked.', status: { daemon: 'error', 'term->daemon': 'error', 'app->daemon': 'error' }, packets: [{ from: 'daemon', to: 'reg', label: 'wait 15 s', tone: 'error' }], focus: ['daemon', 'reg', 'daemon->reg'] },
      { title: 'Now it just takes the port', note: 'The retry loop binds as soon as the old process lets go; clients reconnect in about 100 ms.', status: { daemon: 'success', port: 'success', 'term->daemon': 'plain', 'app->daemon': 'plain', 'daemon->port': 'success' }, packets: [{ from: 'daemon', to: 'port', label: 'bind ✓', tone: 'success' }, { from: 'term', to: 'daemon', tone: 'success' }, { from: 'app', to: 'daemon', tone: 'success' }] },
    ],
  },
  {
    type: 'diff',
    kicker: 'Fix 1 of 2 · src/server/bind.ts',
    title: 'Loop on the bind, not on a *registration*',
    git: { ...git, path: 'src/server/bind.ts' },
    intro: { title: 'Before', note: 'On `EADDRINUSE`, `bind` hands off to `waitForIncumbent` and blocks for up to **15 seconds** — even when the old server is already gone.' },
    steps: [
      {
        title: 'Name the limits',
        note: 'The registry reader replaces the waiting helper, and the magic numbers get names.',
        changes: [1, 2],
        callouts: [{ at: 'RETRY_INTERVAL = 100', text: 'poll every 100 ms', tone: 'accent' }],
      },
      {
        title: 'Wrap the bind in a loop',
        note: 'The existing `try` block moves *inside* a loop. A failed bind no longer ends the attempt — it only checks whether a **live** server owns the port.',
        changes: [3],
        callouts: [
          { at: 'for (;;)', text: 'retry until the deadline', tone: 'accent' },
          { at: 'incumbent?.alive', text: 'a live server still wins', tone: 'success' },
        ],
      },
      {
        title: 'Sleep between attempts',
        note: 'A tiny helper keeps the loop from spinning.',
        changes: [4],
        focus: ['sleep'],
        callouts: [{ at: 'await sleep(RETRY_INTERVAL)', text: 'no busy-wait', tone: 'info' }],
      },
    ],
  },
  {
    type: 'diff',
    kicker: 'Fix 2 of 2 · src/server/registry.ts',
    title: 'Delete the helper that waited for *nobody*',
    git: { ...git, path: 'src/server/registry.ts' },
    mode: 'review',
    intro: { note: '`waitForIncumbent` polled the registration file every 250 ms — the only caller was the old `bind`.' },
    steps: [{ title: 'Remove waitForIncumbent', note: 'Ten lines go. `readRegistration` stays: the new loop calls it directly.', focus: ['function readRegistration'] }],
  },
  {
    type: 'diff',
    kicker: 'Tests · test/bind.test.ts',
    title: 'Prove the hand-off, and the *guard*',
    git: { ...git, path: 'test/bind.test.ts' },
    intro: { title: 'A new test file', note: 'Two behaviors matter: fast hand-off and never replacing a live server.' },
    steps: [
      {
        title: 'Two focused tests',
        note: 'The first closes a fake old server after 300 ms and expects `bind` to win within a second. The second keeps the port busy and expects a rejection.',
        callouts: [
          { at: 'toBeLessThan(1_000)', text: 'hand-off under 1 s', tone: 'success' },
          { at: 'rejects.toThrow()', text: 'live server wins', tone: 'warning' },
        ],
      },
    ],
  },
  {
    type: 'metrics',
    kicker: 'Impact · staging, 1,000 restarts',
    title: 'Restarts got *two orders* of magnitude faster',
    metrics: [
      { label: 'Restart time (p50)', before: 15200, after: 142, unit: 'ms', better: 'lower' },
      { label: 'Failed restarts', before: 23, after: 0.4, unit: '%', better: 'lower', decimals: 1 },
      { label: 'Bind attempts / restart', before: 1, after: 2.3, decimals: 1, note: 'Extra attempts are cheap: 100 ms apart.' },
    ],
  },
  {
    type: 'compare',
    kicker: 'User experience',
    title: 'What people *notice*',
    before: { label: 'Before', points: ['Restart hangs for 15 s, then fails', 'Roughly 1 in 4 restarts on fast machines', 'Users `kill -9` the daemon by hand'] },
    after: { label: 'After', points: ['Restart completes in ~140 ms', 'A live daemon is still never replaced', 'No manual cleanup'] },
  },
  {
    type: 'points',
    kicker: 'Review',
    title: 'Where to look *closely*',
    layout: 'checklist',
    points: [
      { title: 'The deadline still bounds the loop', body: '`Date.now() > deadline` throws after 15 s, so a wedged port cannot spin forever.', tag: 'risk', tone: 'warning' },
      { title: 'Live incumbents still win', body: '`incumbent?.alive` throws `AlreadyRunning` before any retry.', tag: 'fix', tone: 'success' },
      { title: 'No busy-wait', body: 'One `readRegistration` and a 100 ms sleep per attempt.', tag: 'perf', tone: 'info' },
      { title: 'Tests cover both paths', body: 'Hand-off under a second, and the live-server guard.', tag: 'test', tone: 'info' },
    ],
  },
]
