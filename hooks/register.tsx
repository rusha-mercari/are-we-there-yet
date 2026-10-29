import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Finished, History, Tracked } from '../types'

const agents = atom({ plugin: 'are-we-there-yet', key: 'agents' } as const, {})
const done = atom({ plugin: 'are-we-there-yet', key: 'done' } as const, [])
const history = atom({ plugin: 'are-we-there-yet', key: 'history' } as const, {})
const expanded = atom({ plugin: 'are-we-there-yet', key: 'expanded' } as const, null)
const showArrived = atom({ plugin: 'are-we-there-yet', key: 'showArrived' } as const, false)
const showRecord = atom({ plugin: 'are-we-there-yet', key: 'showRecord' } as const, false)
const now = atom({ plugin: 'are-we-there-yet', key: 'now' } as const, 0)
const isHidden = atom({ plugin: 'are-we-there-yet', key: 'isHidden' } as const, false)

const DECK = 'are-we-there-yet'
const DECK_TITLE = 'Are we there yet?'

// Guesses for an agent type nobody has timed yet.
const BASELINE: Record<string, { ms: number; steps: number }> = {
  Explore: { ms: 90_000, steps: 15 },
  Plan: { ms: 120_000, steps: 15 },
  'general-purpose': { ms: 180_000, steps: 25 },
  fork: { ms: 150_000, steps: 20 },
}
const DEFAULT_BASELINE = { ms: 150_000, steps: 20 }

// Seconds an agent may be absent from $.agent.list() before it counts as gone.
const MISSING_TICKS_ALLOWED = 5

// Prose this long in one response, with no tool call yet, reads as the final report.
const WRAP_UP_CHARS = 300
// Tools a subagent calls to deliver its final report.
const REPORT_TOOLS = new Set(['SubagentHandback'])
// The most time left a wrapping-up agent is given.
const WRAP_UP_MS = 20_000

// How many finished trips the deck keeps on show.
const ARRIVALS_KEPT = 6

// Everything drawn is plain ASCII so columns line up in any terminal or locale.
const SEP = ' | '

const TOOL_QUIPS: Record<string, string[]> = {
  Read: ['reading the fine print', 'squinting at a file', 'skimming, allegedly'],
  Grep: ['rummaging through drawers', 'grepping like its life depends on it'],
  Glob: ['counting files for fun', 'herding *.ts files'],
  Bash: ['poking the terminal', 'running a command and hoping'],
  Edit: ['performing surgery', 'moving one semicolon'],
  Write: ['writing a masterpiece', 'typing furiously'],
  WebSearch: ['asking the internet', 'reading the 2nd page of results'],
  WebFetch: ['downloading the internet', 'waiting on someone else\'s server'],
  Agent: ['hiring an intern', 'delegating like a manager'],
  TodoWrite: ['making a list, checking it twice', 'crossing things off, sort of'],
  Skill: ['reading the manual for once', 'consulting the ancient scrolls'],
  ToolSearch: ['looking for the right wrench', 'rummaging in the toolbox'],
  NotebookEdit: ['scribbling in the notebook', 'rearranging notebook cells'],
}
const IDLE_QUIPS = [
  'thinking very hard',
  'staring into the middle distance',
  'having an idea, maybe',
  'mulling it over',
  'consulting the inner rubber duck',
]

const WRAP_UP_QUIPS = ['writing it all down', 'putting a bow on it', 'drafting the victory speech']

const PHASES: [number, string][] = [
  [0.15, 'stretching'],
  [0.45, 'in the zone'],
  [0.75, 'smelling the finish line'],
  [1, 'wrapping up, probably'],
]

const EXCUSES = [
  'got distracted by a really interesting file',
  'the estimate has left the building',
  'not stuck, just thinking deeply',
  'ETA was a lie, sorry',
  'found a rabbit hole and went in',
  'taking the scenic route',
  'stopped to ask for directions',
  'one more file, promise',
  'the progress bar is just shy',
  'measuring twice, cutting eventually',
]

const pick = <T,>(list: T[], seed: number): T => list[Math.abs(seed) % list.length]!

const hash = (text: string) => {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return h
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return s % 60 === 0 ? `${m}m` : `${m}m${String(s % 60).padStart(2, '0')}s`
}

const fmtRange = (ms: number) => {
  if (ms < 15_000) return 'any second now'
  if (ms < 60_000) return `~${Math.round((ms * 0.6) / 5000) * 5 || 5}-${Math.round((ms * 1.4) / 5000) * 5}s`
  const lo = Math.max(1, Math.round((ms * 0.6) / 60_000))
  const hi = Math.max(lo + 1, Math.round((ms * 1.4) / 60_000))
  return `~${lo}-${hi} min`
}

// Combines the up-front guess with how fast the agent is actually going.
export function estimate(t: Tracked, at: number) {
  // The ticking clock can lag a just-spawned agent's start by up to a second.
  const elapsed = Math.max(0, at - t.startedAt)
  const stepProgress = Math.min(0.95, t.steps / t.expectedSteps)
  const timeProgress = elapsed / t.expectedMs
  // Early on trust the clock-based guess; as steps pile up, trust the pace.
  const weight = Math.min(0.7, t.steps / 10)
  const blended = (1 - weight) * timeProgress + weight * stepProgress
  const floor = Math.max(t.maxProgress ?? 0, t.isWrappingUp ? 0.9 : 0)
  const progress = Math.min(0.99, Math.max(floor, blended))
  const projected = progress > 0.05 ? elapsed / progress : t.expectedMs
  const remaining = Math.max(0, projected - elapsed)
  return {
    elapsed,
    progress,
    remaining: t.isWrappingUp ? Math.min(remaining, WRAP_UP_MS) : remaining,
    isOverdue: !t.isWrappingUp && elapsed > t.expectedMs * 1.25,
  }
}

const bar = (progress: number, track: number) => {
  const filled = Math.max(0, Math.min(track, Math.round((progress || 0) * track)))
  return `[${'#'.repeat(filled)}${'-'.repeat(track - filled)}] ${String(Math.round(progress * 100)).padStart(3)}%`
}

const confidenceOf = (samples: number) => (samples >= 5 ? 'high' : samples > 0 ? 'medium' : 'low')

const openDeck = ($: EngineInterface) => $.ui.open({ id: DECK, title: DECK_TITLE })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'eta',
      description: 'Open the "are we there yet?" deck of running subagents',
    })

    const learned: Record<string, History> = {}
    for (const key of await $.store.keys()) {
      if (key.startsWith('history:')) learned[key.slice(8)] = (await $.store.get(key)) as History
    }
    await update($, history, () => learned)

    $.clock.every(1000, async () => {
      const tracked = await read($, agents)
      if (Object.keys(tracked).length === 0) return
      const at = await $.clock.now()

      const live = new Map((await $.agent.list()).map(a => [a.id, a.status]))
      const ended: Finished[] = []
      const missing = new Set<string>()
      for (const t of Object.values(tracked)) {
        const status = live.get(t.id)
        // The list can lag a spawn: only give up on an agent missing for a while.
        if (status === undefined && (t.missingTicks ?? 0) < MISSING_TICKS_ALLOWED) {
          missing.add(t.id)
          continue
        }
        const hasEnded = status === undefined || status === 'completed' || status === 'failed' || status === 'killed'
        if (!hasEnded) continue
        ended.push({
          id: t.id,
          type: t.type,
          description: t.description,
          elapsedMs: at - t.startedAt,
          predictedMs: t.expectedMs,
          status: status ?? 'vanished',
          at,
        })
        if (status === 'completed') await learn($, t, at - t.startedAt)
      }

      await update($, agents, all => {
        const rest = { ...all }
        for (const f of ended) delete rest[f.id]
        for (const [id, t] of Object.entries(rest)) {
          // Kept here, outside drawing, so the bar never moves backwards.
          rest[id] = {
            ...t,
            maxProgress: Math.max(t.maxProgress ?? 0, estimate(t, at).progress),
            missingTicks: missing.has(id) ? (t.missingTicks ?? 0) + 1 : 0,
          }
        }
        return rest
      })
      if (ended.length > 0) {
        await update($, done, list => [...ended, ...list].slice(0, ARRIVALS_KEPT))
        for (const f of ended) $.ui.toast(verdict(f))
      }
      await update($, now, () => at)
    })
    return next(e)
  })

  on('command.run', { command: 'eta' }, async $ => {
    await openDeck($)
    return { text: 'Opened the deck. Buckle up.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (!result.agentId) return result

    const learned = (await read($, history))[e.subagentType]
    const base = BASELINE[e.subagentType] ?? DEFAULT_BASELINE
    // Longer briefs tend to mean bigger jobs; clamp so a novel doesn't predict a week.
    const sizeFactor = Math.min(1.8, Math.max(0.7, e.prompt.length / 1200))
    const tracked: Tracked = {
      id: result.agentId,
      type: e.subagentType,
      description: e.description,
      brief: e.prompt.slice(0, 280),
      startedAt: await $.clock.now(),
      steps: 0,
      lastTool: null,
      recentTools: [],
      expectedMs: Math.max(5000, (learned?.avgMs ?? base.ms) * sizeFactor),
      expectedSteps: Math.max(3, (learned?.avgSteps ?? base.steps) * sizeFactor),
      samples: learned?.n ?? 0,
    }
    await update($, agents, all => ({ ...all, [tracked.id]: tracked }))
    await update($, isHidden, () => false)
    void openDeck($)
    return result
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      await update($, agents, all => {
        const t = all[id]
        if (!t) return all
        const recentTools = [...(t.recentTools ?? []), e.tool].slice(-3)
        return { ...all, [id]: { ...t, steps: t.steps + 1, lastTool: e.tool, recentTools } }
      })
    }
    return next(e)
  })

  // Watches each model response of a tracked agent: long prose with no tool call
  // is usually the final report. One state write per change, never per chunk.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id === undefined || !(await read($, agents))[id]) return yield* next(e)

    const setWrappingUp = (isWrappingUp: boolean) =>
      update($, agents, all => {
        const t = all[id]
        return t ? { ...all, [id]: { ...t, isWrappingUp } } : all
      })

    const stream = next(e)
    let prose = 0
    let isFlagged = false
    for await (const chunk of stream) {
      if (chunk.kind === 'text') {
        prose += chunk.text.length
        if (!isFlagged && prose >= WRAP_UP_CHARS) {
          isFlagged = true
          await setWrappingUp(true)
        }
      } else if (chunk.kind === 'tool') {
        // A subagent that hands its report back does so through this tool:
        // the report streams as its arguments, not as prose.
        const isReporting = REPORT_TOOLS.has(chunk.name)
        if (isReporting !== isFlagged) {
          isFlagged = isReporting
          await setWrappingUp(isReporting)
        }
      }
      yield chunk
    }
    await update($, agents, all => {
      const t = all[id]
      return t ? { ...all, [id]: { ...t, modelRequests: (t.modelRequests ?? 0) + 1 } } : all
    })
    return await stream.result
  })

  // The band is a one-line summary; the deck has the detail.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const tracked = Object.values(await read($, agents))
    if (e.props.hasSurvey || tracked.length === 0 || (await read($, isHidden))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const at = (await read($, now)) || (await $.clock.now())
    const soonest = Math.min(...tracked.map(t => estimate(t, at).remaining))

    return (
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text bold>{tracked.length} en route</Text>
          <Text dimColor>{SEP}next arrival </Text>
          <Text color="green">{fmtRange(soonest)}</Text>
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="deck" plain label="deck" onPress={() => openDeck($)} />
          <Button key="hide" plain label="hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: DECK }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const tracked = Object.values(await read($, agents)).sort((a, b) => a.startedAt - b.startedAt)
    const arrivals = await read($, done)
    const learned = await read($, history)
    const open = await read($, expanded)
    const isArrivedOpen = await read($, showArrived)
    const isRecordOpen = await read($, showRecord)
    const at = (await read($, now)) || (await $.clock.now())
    const tick = Math.floor(at / 4000)

    const cols = Math.max(1, e.props.bodyColumns)
    const perRow = cols >= 84 ? 2 : 1
    const cardWidth = perRow === 2 ? Math.floor((cols - 1) / 2) : cols
    // Card border and padding take 4 columns; the brackets and "100%" after the bar take 7.
    const track = Math.max(1, cardWidth - 4 - 7)

    const soonest = tracked.length
      ? fmtRange(Math.min(...tracked.map(t => estimate(t, at).remaining)))
      : null
    const hits = arrivals.filter(f => f.status === 'completed' && isOnTarget(f)).length

    return (
      <Box flexDirection="column" gap={1}>
        <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
          <Text bold>ARE WE THERE YET?</Text>
          <Text>
            <Text color={tracked.length ? 'green' : undefined} dimColor={!tracked.length}>
              {tracked.length ? `${tracked.length} en route` : 'parked'}
            </Text>
            {soonest && <Text dimColor>{SEP}next arrival </Text>}
            {soonest && <Text color="green">{soonest}</Text>}
            {arrivals.length > 0 && (
              <Text dimColor>
                {SEP}{arrivals.length} arrived{SEP}{hits}/{arrivals.length} on target
              </Text>
            )}
          </Text>
        </Box>

        {tracked.length === 0 && (
          <Box borderStyle="round" borderDimColor paddingX={1}>
            <Text dimColor>No agents on the road.</Text>
          </Box>
        )}

        {tracked.length > 0 && (
          <Box flexDirection="column">
            <Text bold dimColor>EN ROUTE</Text>
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
              {tracked.map((t, i) => {
                const est = estimate(t, at)
                const seed = tick + hash(t.id)
                const doing = t.isWrappingUp
                  ? pick(WRAP_UP_QUIPS, seed)
                  : t.lastTool
                    ? pick(TOOL_QUIPS[t.lastTool] ?? [`fiddling with ${t.lastTool}`], seed)
                    : pick(IDLE_QUIPS, seed)
                const phase = t.isWrappingUp
                  ? 'writing the report'
                  : est.isOverdue
                    ? 'overtime'
                    : PHASES.find(([p]) => est.progress < p)?.[1] ?? 'wrapping up, probably'
                const accent = t.isWrappingUp ? 'cyan' : est.isOverdue ? 'yellow' : 'green'
                const status = t.isWrappingUp ? 'ALMOST DONE' : est.isOverdue ? 'OVERTIME' : 'RUNNING'
                const isOpen = open === t.id
                const hotkey = i < 9 ? String(i + 1) : undefined
                return (
                  <Box
                    key={t.id}
                    width={cardWidth}
                    borderStyle="round"
                    borderColor={accent}
                    paddingX={1}
                    flexDirection="column"
                  >
                    <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={1}>
                      <Button
                        key={`card-${t.id}`}
                        plain
                        hotkey={hotkey}
                        onPress={() => update($, expanded, cur => (cur === t.id ? null : t.id))}
                      >
                        <Text bold>{t.type}</Text>
                      </Button>
                      <Text bold color={accent}>{status}</Text>
                    </Box>
                    <Text>{t.description}</Text>
                    <Text>
                      <Text dimColor>ETA </Text>
                      <Text bold color={accent}>
                        {t.isWrappingUp
                          ? 'almost there, honest!'
                          : est.isOverdue
                            ? pick(EXCUSES, seed)
                            : fmtRange(est.remaining)}
                      </Text>
                    </Text>
                    <Text color={accent}>{bar(est.progress, track)}</Text>
                    <Text dimColor>
                      {fmt(est.elapsed)} elapsed{SEP}{t.steps} steps{SEP}{t.modelRequests ?? 0} requests
                    </Text>
                    <Text dimColor>
                      {phase}, {doing}
                    </Text>
                    <Text dimColor>confidence: {confidenceOf(t.samples)}</Text>
                    {isOpen && (t.recentTools?.length ?? 0) > 0 && (
                      <Text dimColor>recent: {t.recentTools!.join(' > ')}</Text>
                    )}
                    {isOpen && t.brief && <Text dimColor>brief: {t.brief}</Text>}
                    {isOpen && <Text dimColor>predicted {fmt(t.expectedMs)} total</Text>}
                  </Box>
                )
              })}
            </Box>
          </Box>
        )}

        {arrivals.length > 0 && (
          <Box flexDirection="column">
            <Button key="toggle-arrived" plain hotkey="a" onPress={() => update($, showArrived, v => !v)}>
              <Text bold dimColor>
                [{isArrivedOpen ? '-' : '+'}] ARRIVED ({arrivals.length})
              </Text>
            </Button>
            {isArrivedOpen && (
              <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column">
                {arrivals.map(f => (
                  <Text key={f.id}>
                    <Text color={verdictColor(f)}>{verdict(f)}</Text>
                    <Text dimColor>{SEP}{f.description}</Text>
                  </Text>
                ))}
              </Box>
            )}
          </Box>
        )}

        {Object.keys(learned).length > 0 && (
          <Box flexDirection="column">
            <Button key="toggle-record" plain hotkey="r" onPress={() => update($, showRecord, v => !v)}>
              <Text bold dimColor>
                [{isRecordOpen ? '-' : '+'}] TRACK RECORD ({Object.keys(learned).length} types)
              </Text>
            </Button>
            {isRecordOpen && (
              <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column">
                {Object.entries(learned).map(([type, stats]) => (
                  <Text key={type}>
                    <Text bold>{type}</Text>
                    <Text dimColor>
                      {SEP}{stats.n} {stats.n === 1 ? 'trip' : 'trips'}{SEP}usually {fmt(stats.avgMs)}{SEP}~{Math.round(stats.avgSteps)} steps
                    </Text>
                  </Text>
                ))}
              </Box>
            )}
          </Box>
        )}

        <Text dimColor>
          {tracked.length > 0 ? `1-${Math.min(9, tracked.length)} expand card${SEP}` : ''}a arrivals{SEP}r track record
        </Text>
      </Box>
    )
  })
}

function isOnTarget(f: Finished) {
  return Math.abs(f.predictedMs - f.elapsedMs) < Math.max(10_000, f.predictedMs * 0.15)
}

function verdictColor(f: Finished) {
  if (f.status !== 'completed') return 'red'
  if (isOnTarget(f)) return 'green'
  return f.predictedMs > f.elapsedMs ? 'cyan' : 'yellow'
}

function verdict(f: Finished) {
  if (f.status === 'killed') return `STOPPED  ${f.type} after ${fmt(f.elapsedMs)}`
  if (f.status === 'failed') return `FAILED   ${f.type} after ${fmt(f.elapsedMs)}`
  if (f.status === 'vanished') return `VANISHED ${f.type} after ${fmt(f.elapsedMs)}`
  const diff = f.predictedMs - f.elapsedMs
  if (isOnTarget(f)) return `ON TIME  ${f.type} in ${fmt(f.elapsedMs)}, nailed it`
  return diff > 0
    ? `EARLY    ${f.type} in ${fmt(f.elapsedMs)}, ${fmt(diff)} ahead`
    : `LATE     ${f.type} in ${fmt(f.elapsedMs)}, ${fmt(-diff)} behind`
}

// Rolls a finished run into the per-type averages, weighting recent runs a bit more.
async function learn($: EngineInterface, t: Tracked, elapsedMs: number) {
  const key = `history:${t.type}`
  const prev = ((await $.store.get(key)) as History | undefined) ?? { n: 0, avgMs: elapsedMs, avgSteps: t.steps }
  const alpha = prev.n === 0 ? 1 : Math.max(0.2, 1 / (prev.n + 1))
  const next: History = {
    n: prev.n + 1,
    avgMs: prev.avgMs + alpha * (elapsedMs - prev.avgMs),
    avgSteps: prev.avgSteps + alpha * (Math.max(1, t.steps) - prev.avgSteps),
  }
  await $.store.set(key, next)
  await update($, history, all => ({ ...all, [t.type]: next }))
}
