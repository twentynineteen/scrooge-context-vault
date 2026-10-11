import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage } from 'claude-code'

import type { Fill, Pixels } from '../types'

// Scrooge McDuck's Money Bin as a context window monitor. Coins fill the bin as
// the context fills; at diveAt percent Scrooge jumps off his diving board,
// dives in and swims until the context is cleared or compacted.

const PANE = 'money-bin'
const RASTER = 'bin'
// The percentage at which Scrooge dives in: the `diveAt` setting, read from
// the plugin's options on each load (a change in /config reloads the module).
const DIVE_AT_DEFAULT = 80
let diveAt = DIVE_AT_DEFAULT
const TICK_MS = 100
// The share of the bin's inside that coins can fill; the rest is headroom for
// the diving board and the jump.
const CAPACITY = 0.45

const EMPTY: Fill = { percent: 0, tokens: null, window: 0 }
const fill = atom({ plugin: 'money-bin', key: 'fill' } as const, EMPTY)
const pixels = atom({ plugin: 'money-bin', key: 'pixels' } as const, 'small' as Pixels)

// Colours, 0x00RRGGBB.
const STEEL = 0x5a6270
const RIVET = 0x9aa4b3
const INSIDE = 0x161e2b
const SEAM = 0x1d2738
const DOLLAR = 0x26334a
const PLANK = 0x8b5a2b
const PLANK_EDGE = 0x5e3a18
const GOLD = [0xffd23f, 0xf2b705, 0xd99a00, 0xb87d00]
const GLINT = 0xfff6c2
const SPARKLE = 0xffffff

const PALETTE: Record<string, number> = {
  K: 0x14141f, // top hat
  k: 0x3b4a8c, // hat band
  W: 0xffffff, // feathers, spats
  w: 0xd6dbe6, // mutton-chop sideburns
  E: 0x0a0a0a, // eye
  O: 0xffa62b, // beak, feet
  o: 0xd9801a, // lower beak
  R: 0xd42a2a, // frock coat
  r: 0x9e1b1b, // coat shade
  G: 0x9fd4ff, // pince-nez
  C: 0x6b4423, // cane
}

type Sprite = string[]
// `submerged`: how many of the swim frames' bottom rows sit under the coins.
type Sprites = { standing: Sprite; swim: [Sprite, Sprite]; submerged: number }

// Sprites face right; '.' is transparent. One set per pixel size, drawn so
// Scrooge stands about as tall on screen in both.
const BIG: Sprites = {
  standing: [
    '...KKK...',
    '...KKK...',
    '..KKKKK..',
    '...WWW...',
    '...WGEOO.',
    '...WWWOO.',
    '....WW...',
    '...RRRR..',
    '..WRRrRW.',
    '...RRrR..',
    '....O.O..',
    '...OO.OO.',
  ],
  swim: [
    [
      '...KKK...W',
      '...KKK..W.',
      '..KKKKKR..',
      '...WWWR...',
      '...WGEOO..',
      '...WWWOO..',
      '..RRRRR...',
      '.RRRrRR...',
    ],
    [
      '...KKK....',
      '...KKK....',
      '..KKKKK...',
      '...WWW....',
      '...WGEOO..',
      'W..WWWOO..',
      '.RRRRRR...',
      '..RRrRR...',
    ],
  ],
  submerged: 1,
}

// Quadrant pixels are half as wide as they are tall, so there are twice as
// many across: room for Scrooge's top hat and band, pince-nez, long beak,
// mutton-chop sideburns, frock coat, spats and cane at about BIG's size.
const SMALL_HEAD = [
  '.......KKKK.......',
  '.......KKKK.......',
  '.......kkkk.......',
  '.....KKKKKKKK.....',
  '.....WWWWWEWG.....',
  '.w..WWWWWWWWGOOOO.',
  'w.wWWWWWWWWWOOOOOO',
  '..wWWWWWWWWWooo...',
]

const SMALL: Sprites = {
  standing: [
    ...SMALL_HEAD,
    '.....RRRRRRR......',
    '...WRRRRrRRRRW....',
    '.....RRRrRRR..C...',
    '......WW..WW..C...',
    '.....OOO..OOO.C...',
  ],
  swim: [
    [...SMALL_HEAD, '....RRRRRRRRRRRWW.', '...RRRRRRRRRRR....'],
    [
      // The other arm over his head, mid-stroke.
      'WW.....KKKK.......',
      '.R.....KKKK.......',
      '..R....kkkk.......',
      '...R.KKKKKKKK.....',
      ...SMALL_HEAD.slice(4),
      '....RRRRRRRRR.....',
      '...RRRRRRRRRRR....',
    ],
  ],
  submerged: 1,
}

// How a terminal cell is split into pixels. `big`: the upper half block, two
// square pixels a cell. `small`: quadrant blocks, two by two pixels a cell,
// each half as wide as it is tall, drawn in the two colours that best fit
// them. `ux` is how many pixels across make one square pixel's width.
const GRID: Record<Pixels, { x: number; y: number; ux: number; sprites: Sprites }> = {
  big: { x: 1, y: 2, ux: 1, sprites: BIG },
  small: { x: 2, y: 2, ux: 2, sprites: SMALL },
}

type Phase = 'idle' | 'board' | 'jump' | 'splash' | 'swim'
type Particle = { x: number; y: number; vx: number; vy: number; colour: number }
type Size = { columns: number; rows: number; pixels: Pixels }

const BOARD_TICKS = 12
const JUMP_TICKS = 12
const SPLASH_TICKS = 6

type SceneState = {
  target: number
  shown: number
  phase: Phase
  t: number
  tick: number
  // The pile's shape: it shifts only while coins pour in.
  settle: number
  x: number
  dir: number
  particles: Particle[]
}

// The animation is the module's own: a reload starts it over, which is fine.
const scene: SceneState = {
  target: 0,
  shown: 0,
  phase: 'idle',
  t: 0,
  tick: 0,
  settle: 0,
  x: 0,
  dir: 1,
  particles: [],
}
let size: Size = { columns: 0, rows: 0, pixels: 'small' }
let isMounted = false
// What the apps' SVG last showed: the fill it rose from, and whether Scrooge
// has already dived in, so a redraw does not replay his jump.
const svgMemory: {
  percent: number
  hasDived: boolean
  // When Scrooge's swim began (ms), so a new SVG carries his lap on.
  swimSince: number | null
  scene: { text: string; source: string; alt: string } | null
} = { percent: 0, hasDived: false, swimSince: null, scene: null }
// A fill set by `/money-bin demo`, held over the real figures until turned
// off or the bin is drained by /clear or /compact.
let demo: number | null = null

async function setFill($: EngineInterface, value: Fill) {
  const before = await read($, fill)
  await update($, fill, () => value)
  scene.target = value.percent / 100

  if (before.percent < diveAt && value.percent >= diveAt) {
    $.ui.toast(`Context at ${value.percent}%: Scrooge is diving into the Money Bin!`)
  } else if (before.percent >= diveAt && value.percent < diveAt) {
    $.ui.toast('Money Bin drained. Scrooge climbs out.')
  }
}

// Empties the bin, keeping the window size for the caption.
async function drain($: EngineInterface) {
  demo = null
  const { window } = await read($, fill)
  await setFill($, { ...EMPTY, window })
}

// Holds the setting to a whole percentage from 1 to 100.
function toDiveAt(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.min(100, Math.max(1, Math.round(number))) : DIVE_AT_DEFAULT
}

function fromUsage(context: SessionContextUsage): Fill {
  return { percent: context.percent ?? 0, tokens: context.tokens ?? null, window: context.window }
}

export const register: Register = (on, options) => {
  diveAt = toDiveAt(options.diveAt)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'money-bin',
      description: "Show Scrooge McDuck's Money Bin, filling with your context window",
      argumentHint: '[demo [percent] | demo off | pixels small|big]',
      immediate: true,
    })
    const { context } = await $.session.usage()
    await setFill($, fromUsage(context))
    scene.shown = scene.target

    $.clock.every(TICK_MS, () => {
      step(scene, size)
      const isBusy =
        scene.phase !== 'idle' || scene.particles.length > 0 || scene.shown !== scene.target
      // At rest only the sparkles move, so a slower frame rate does.
      if (!isMounted || size.columns === 0 || (!isBusy && scene.tick % 4 !== 0)) {
        return
      }
      void $.ui
        .blit({ requestId: PANE, key: RASTER, cells: encode(paint(scene, size), size) })
        .then(result => {
          if ('deny' in result && result.deny) isMounted = false
        })
    })
    // The terminal shows the bin in a pane; the apps show it above the
    // message box instead (the AbovePrompt band), where a pane would dock.
    if (!(await isInApp($))) {
      void $.ui.open({ id: PANE, title: 'Money Bin' })
    }

    return next(e)
  })

  on('command.run', { command: 'money-bin' }, async ($, e) => {
    const opened = (await isInApp($)) ? null : await $.ui.open({ id: PANE, title: 'Money Bin' })
    const [word, value] = e.args.trim().split(/\s+/)

    if (word === 'pixels' && (value === 'small' || value === 'big')) {
      await update($, pixels, () => value)

      return { text: `Money Bin pixels: ${value}.` }
    }

    if (word === 'demo' && value === 'off') {
      demo = null
      const { context } = await $.session.usage()
      await setFill($, fromUsage(context))

      return { text: 'Money Bin demo off: back to the real context window.' }
    }

    if (word === 'demo') {
      const percent = clamp(Math.round(Number(value ?? 85)) || 85, 0, 100)
      demo = percent
      const { window } = await read($, fill)
      await setFill($, { percent, tokens: Math.round((percent / 100) * window), window })

      return { text: `Money Bin demo: ${percent}%. /money-bin demo off, /clear or /compact to stop.` }
    }

    if (opened === null) {
      return { text: 'The Money Bin is above the message box.' }
    }

    return { text: opened.isPlaced ? 'Money Bin opened.' : 'Money Bin is waiting for room on screen.' }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context') && demo === null) {
      await setFill($, fromUsage(e.context))
    }

    return next(e)
  })

  // A compaction or a /clear empties the live window; the next turn measures
  // it again, but Scrooge should not keep swimming until then.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    const isApplied = e.trigger !== 'precompute' && e.agentId === undefined && !result.skip
    if (isApplied) {
      // The bin's state is decoration: a failure here never holds up the compaction.
      await drain($).catch(() => undefined)
    }

    return result
  })

  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    await drain($).catch(() => undefined)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const value = await read($, fill)
    scene.target = value.percent / 100
    const isSwimming = value.percent >= diveAt
    const caption = (
      <Text>
        <Text bold color={isSwimming ? 'red' : 'yellow'}>
          {value.percent}%
        </Text>
        <Text dimColor>
          {value.tokens === null
            ? ` of ${tokens(value.window)} tokens`
            : ` · ${tokens(value.tokens)} of ${tokens(value.window)} tokens`}
        </Text>
      </Text>
    )
    const hint = isSwimming ? (
      <Text color="red" wrap="truncate-end">
        Scrooge is swimming in it! /compact or /clear to drain the bin.
      </Text>
    ) : (
      <Text dimColor wrap="truncate-end">
        Scrooge dives in at {diveAt}%.
      </Text>
    )

    if (e.surface !== 'terminal') {
      // The apps draw no cells: the bin goes as an SVG that animates itself,
      // redrawn only when the fill moves.
      const { Svg } = $.ui.resolve(e)
      const { source, alt } = appScene(value)

      return (
        <Box flexDirection="column">
          <Svg source={source} alt={alt} width={STRIP_WIDTH} height={STRIP_HEIGHT} isInteractive />
          {caption}
          {hint}
        </Box>
      )
    }

    const { Raster } = $.ui.resolve(e)
    const columns = clamp(e.props.bodyColumns, 24, 72)
    // Docked, the bin takes the pane's height; above the prompt, a quarter of
    // the window, so the prompt stays on screen.
    const room =
      e.props.placement === 'dock'
        ? e.props.scroll.bodyRows - 2
        : Math.round((e.viewport?.rows ?? 48) / 4)
    const rows = clamp(Math.min(room, Math.round(columns * 0.45)), 12, 24)
    const next: Size = { columns, rows, pixels: await read($, pixels) }
    if (next.pixels !== size.pixels) {
      // Positions are in pixels, so a new grid starts the swim over.
      scene.particles = []
      if (scene.phase !== 'idle') scene.phase = 'swim'
      scene.x = jumpEnd(columns * GRID[next.pixels].x)
    }
    size = next
    isMounted = true

    return (
      <Box flexDirection="column">
        <Raster key={RASTER} columns={columns} rows={rows} cells={encode(paint(scene, size), size)} />
        {caption}
        {hint}
      </Box>
    )
  })

  // An app that joins later takes the bin above its message box, so the pane
  // the terminal opened goes: the app would dock it at the side.
  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    if (e.surface !== 'terminal') {
      await $.ui.close({ id: PANE }).catch(() => undefined)
    }

    return result
  })

  // In the apps the bin sits above the message box, over whatever else draws
  // there; the terminal keeps its pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' || e.props.hasSurvey) {
      return next(e)
    }

    const below = await next(e)
    const { Box, Svg } = $.ui.resolve(e)
    const { source, alt } = appScene(await read($, fill))

    // The strip spans the band, its figures drawn inside it.
    return (
      <Box flexDirection="column">
        <Svg source={source} alt={alt} width={STRIP_WIDTH} height={STRIP_HEIGHT} isInteractive />
        {below}
      </Box>
    )
  })
}

// Whether one of the apps (desktop, VS Code, mobile) draws this session. It
// may run a terminal REPL beneath, so a terminal in the list is no sign.
async function isInApp($: EngineInterface) {
  return (await $.session.surfaces()).some(surface => surface !== 'terminal')
}

// The bin as the apps draw it: an SVG, and the words a reader without it gets.
// The apps redraw the band whenever its props move (a turn starting, say), and
// a different SVG restarts its animation, so it is built once per fill and the
// same one handed back until the fill moves.
function appScene(value: Fill) {
  const figures =
    value.tokens === null
      ? `${value.percent}%`
      : `${value.percent}% · ${tokens(value.tokens)} of ${tokens(value.window)}`
  const isSwimming = value.percent >= diveAt
  const label: Label = isSwimming
    ? { text: `${figures} · /compact to drain`, colour: 0xff6b6b }
    : { text: figures, colour: GOLD[0]! }
  if (svgMemory.scene?.text === label.text) {
    return svgMemory.scene
  }
  const previous = svgMemory.percent
  const isIntro = isSwimming && !svgMemory.hasDived
  svgMemory.percent = value.percent
  svgMemory.hasDived = isSwimming
  const now = Date.now()
  if (!isSwimming) {
    svgMemory.swimSince = null
  } else if (isIntro || svgMemory.swimSince === null) {
    svgMemory.swimSince = now + (isIntro ? INTRO_SECONDS * 1000 : 0)
  }
  const swimAge = svgMemory.swimSince === null ? 0 : Math.max(0, (now - svgMemory.swimSince) / 1000)
  svgMemory.scene = {
    text: label.text,
    source: svgScene(value.percent, previous, isIntro, swimAge, label),
    alt: isSwimming
      ? `Money Bin ${value.percent}% full: Scrooge McDuck is swimming in the coins`
      : `Money Bin ${value.percent}% full of coins`,
  }

  return svgMemory.scene
}

// One animation step: the coin level eases toward the context fill, coins rain
// in while it rises, and Scrooge works through his phases.
function step(scene: SceneState, size: Size) {
  scene.tick += 1
  if (size.columns === 0) return
  const grid = GRID[size.pixels]
  const ux = grid.ux
  const { standing, swim } = grid.sprites
  const layout = measure(size)
  const { width } = layout

  const gap = scene.target - scene.shown
  if (Math.abs(gap) < 0.002) {
    scene.shown = scene.target
  } else {
    scene.shown += gap > 0 ? Math.min(gap, Math.max(0.004, gap * 0.08)) : Math.max(gap, gap * 0.25)
    if (gap > 0) {
      scene.settle += 1
      for (let i = 0; i < 2 * ux; i++) {
        scene.particles.push({
          x: ux + Math.random() * (width - 2 * ux),
          y: 1,
          vx: 0,
          vy: 0.5 + Math.random() * 0.5,
          colour: GOLD[Math.floor(Math.random() * 2)]!,
        })
      }
    }
  }

  const wantsSwim = scene.target * 100 >= diveAt
  if (!wantsSwim) {
    scene.phase = 'idle'
  } else if (scene.phase === 'idle') {
    scene.phase = 'board'
    scene.t = 0
  }

  scene.t += 1
  const surface = surfaceRow(layout, scene.shown)
  const swimWidth = swim[0][0]!.length
  if (scene.phase === 'board' && scene.t > BOARD_TICKS) {
    scene.phase = 'jump'
    scene.t = 0
  } else if (scene.phase === 'jump' && scene.t > JUMP_TICKS) {
    scene.phase = 'splash'
    scene.t = 0
    scene.x = jumpEnd(width)
    scene.dir = 1
    for (let i = 0; i < 16 * ux; i++) {
      scene.particles.push({
        x: scene.x + standing[0]!.length / 2 + (Math.random() - 0.5) * 3 * ux,
        y: surface - 1,
        vx: (Math.random() - 0.5) * 1.6 * ux,
        vy: -1.2 - Math.random() * 1.4,
        colour: i % 3 === 0 ? GLINT : GOLD[i % 2]!,
      })
    }
  } else if (scene.phase === 'splash' && scene.t > SPLASH_TICKS) {
    scene.phase = 'swim'
    scene.t = 0
  } else if (scene.phase === 'swim') {
    scene.x += scene.dir * 0.5 * ux
    const right = width - ux - swimWidth
    if (scene.x >= right) {
      scene.x = right
      scene.dir = -1
    } else if (scene.x <= ux) {
      scene.x = ux
      scene.dir = 1
    }
    if (scene.t % 3 === 0) {
      const behind = scene.dir > 0 ? scene.x : scene.x + swimWidth - 1
      for (let i = 0; i < ux; i++) {
        scene.particles.push({
          x: behind,
          y: surface - 1,
          vx: -scene.dir * (0.3 + Math.random() * 0.4) * ux,
          vy: -0.8 - Math.random() * 0.6,
          colour: GOLD[(scene.t + i) % 2]!,
        })
      }
    }
  }

  scene.particles = scene.particles.filter(p => {
    p.vy += 0.22
    p.x += p.vx
    p.y += p.vy
    const x = Math.round(p.x)
    const isInside = x >= ux && x < width - ux

    return isInside && p.y < surfaceAt(layout, scene.shown, x, scene.settle)
  })
}

type Layout = {
  width: number
  height: number
  ux: number
  floor: number
  capacity: number
  board: number
}

function measure(size: Size): Layout {
  const grid = GRID[size.pixels]
  const width = size.columns * grid.x
  const height = size.rows * grid.y
  const floor = height - 2
  const capacity = Math.round((height - 2) * CAPACITY)
  const standing = grid.sprites.standing.length

  return {
    width,
    height,
    ux: grid.ux,
    floor,
    capacity,
    board: Math.max(standing + 1, floor + 1 - Math.round((diveAt / 100) * capacity) - 3),
  }
}

// The topmost coin row at the level `shown` (0 to 1), before the pile's bumps.
function surfaceRow(layout: Layout, shown: number) {
  return layout.floor + 1 - Math.round(shown * layout.capacity)
}

function surfaceAt(layout: Layout, shown: number, x: number, settle: number) {
  const base = surfaceRow(layout, shown)
  if (base > layout.floor) return layout.floor + 1
  const column = x / layout.ux
  const wave = Math.sin(column * 0.45 + settle * 0.05) * 0.7 + Math.sin(column * 0.17 + 1) * 0.6

  return Math.min(layout.floor, base + Math.round(wave))
}

function jumpEnd(width: number) {
  return Math.round(width * 0.3)
}

function paint(scene: SceneState, size: Size) {
  const layout = measure(size)
  const { width, height, ux } = layout
  const { standing, swim } = GRID[size.pixels].sprites
  const px = new Uint32Array(width * height)
  const set = (x: number, y: number, colour: number) => {
    if (x >= 0 && x < width && y >= 0 && y < height) px[y * width + x] = colour
  }

  // The inside, with panel seams and a big dollar sign on the back wall.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) set(x, y, Math.floor(x / ux) % 7 === 3 ? SEAM : INSIDE)
  }
  drawDollar(set, Math.floor(width / 2) - 2 * ux, 3, ux)

  // Scrooge goes in before the coins, so the coins cover whatever is under.
  const surface = surfaceRow(layout, scene.shown)
  // A quadrant cell holds two colours, so sprites sit on the cell grid there.
  const snapX = (x: number) => Math.round(x / ux) * ux
  if (scene.phase === 'board') {
    const crouch = scene.t > BOARD_TICKS - 4 ? 1 : 0
    drawSprite(set, standing, ux, layout.board - standing.length + crouch, false, false)
  } else if (scene.phase === 'jump') {
    const p = scene.t / JUMP_TICKS
    const x = ux + p * (jumpEnd(width) - ux)
    const feet =
      layout.board - 1 + p * (surface + standing.length - layout.board) - Math.sin(p * Math.PI) * 5
    drawSprite(set, standing, snapX(x), Math.round(feet) - standing.length + 1, false, p > 0.5)
  } else if (scene.phase === 'swim') {
    const frame = swim[Math.floor(scene.t / 3) % 2]!
    // Head, beak and stroking arm above the coins; the rest of him under.
    const top = Math.max(1, surface - frame.length + GRID[size.pixels].sprites.submerged)
    drawSprite(set, frame, snapX(scene.x), top, scene.dir < 0, false)
  }

  // Coins: a gold pile with a bumpy top, glints and a few sparkles.
  for (let x = ux; x < width - ux; x++) {
    const top = surfaceAt(layout, scene.shown, x, scene.settle)
    for (let y = top; y <= layout.floor; y++) {
      // One coin is a square pixel, so `ux` pixels across share its shade.
      const coin = Math.floor(x / ux)
      const h = hash(coin, y)
      let colour = GOLD[h % 16 < 7 ? 0 : h % 16 < 12 ? 1 : h % 16 < 15 ? 2 : 3]!
      if (y === top) colour = h % 5 === 0 ? GLINT : GOLD[0]!
      if (y <= top + 1 && hash(coin, y + scene.tick / 3) % 61 === 0) colour = SPARKLE
      set(x, y, colour)
    }
  }

  // The diving board, bolted to the left wall.
  for (let x = ux; x < 7 * ux; x++) set(x, layout.board, PLANK)
  for (let x = ux; x < 3 * ux; x++) set(x, layout.board + 1, PLANK_EDGE)

  for (const p of scene.particles) set(Math.round(p.x), Math.round(p.y), p.colour)

  // The steel walls and their rivets.
  for (let x = 0; x < width; x++) {
    const colour = Math.floor(x / ux) % 4 === 2 ? RIVET : STEEL
    set(x, 0, colour)
    set(x, height - 1, colour)
  }
  for (let y = 0; y < height; y++) {
    for (let t = 0; t < ux; t++) {
      set(t, y, y % 4 === 2 ? RIVET : STEEL)
      set(width - 1 - t, y, y % 4 === 2 ? RIVET : STEEL)
    }
  }

  return px
}

function drawSprite(
  set: (x: number, y: number, colour: number) => void,
  sprite: Sprite,
  left: number,
  top: number,
  isMirrored: boolean,
  isUpsideDown: boolean,
) {
  const height = sprite.length
  sprite.forEach((line, row) => {
    const width = line.length
    for (let col = 0; col < width; col++) {
      const colour = PALETTE[line[col]!]
      if (colour === undefined) continue
      const x = left + (isMirrored ? width - 1 - col : col)
      const y = top + (isUpsideDown ? height - 1 - row : row)
      set(x, y, colour)
    }
  })
}

const DOLLAR_SIGN = ['.###.', '#.#..', '.###.', '..#.#', '.###.']

function drawDollar(set: (x: number, y: number, colour: number) => void, left: number, top: number, ux: number) {
  const dot = (col: number, row: number) => {
    for (let dx = 0; dx < ux; dx++) set(left + col * ux + dx, top + row, DOLLAR)
  }
  DOLLAR_SIGN.forEach((line, row) => {
    for (let col = 0; col < line.length; col++) {
      if (line[col] === '#') dot(col, row)
    }
  })
  dot(2, -1)
  dot(2, DOLLAR_SIGN.length)
}

// Quadrant blocks by which of a cell's pixels take the foreground: bit 1 top
// left, 2 top right, 4 bottom left, 8 bottom right.
const QUADRANT = [
  0x20, 0x2598, 0x259d, 0x2580, 0x2596, 0x258c, 0x259e, 0x259b,
  0x2597, 0x259a, 0x2590, 0x259c, 0x2584, 0x2599, 0x259f, 0x2588,
]

function encode(px: Uint32Array, size: Size) {
  const { columns, rows } = size
  const words = new Uint32Array(columns * rows * 3)
  const width = columns * GRID[size.pixels].x

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const i = (row * columns + col) * 3
      if (size.pixels === 'big') {
        // The upper half block: the top pixel its foreground, the bottom one its background.
        words[i] = 0x2580
        words[i + 1] = px[row * 2 * width + col]!
        words[i + 2] = px[(row * 2 + 1) * width + col]!
        continue
      }
      // Quadrants: the cell's two best colours, the commoner one as the
      // background and the quadrants nearer the other as the foreground.
      const top = row * 2 * width + col * 2
      const cell = [px[top]!, px[top + 1]!, px[top + width]!, px[top + width + 1]!]
      const [back, fore] = twoColours(cell)
      let bits = 0
      cell.forEach((colour, k) => {
        if (colour !== back && distance(colour, fore) < distance(colour, back)) bits |= 1 << k
      })
      words[i] = QUADRANT[bits]!
      words[i + 1] = fore
      words[i + 2] = back
    }
  }

  return base64(new Uint8Array(words.buffer))
}

function twoColours(cell: number[]): [number, number] {
  const counts = new Map<number, number>()
  for (const colour of cell) counts.set(colour, (counts.get(colour) ?? 0) + 1)
  let back = cell[0]!
  for (const [colour, n] of counts) if (n > counts.get(back)!) back = colour
  let fore = back
  let best = -1
  for (const [colour, n] of counts) {
    const score = n * distance(colour, back)
    if (colour !== back && score > best) {
      best = score
      fore = colour
    }
  }

  return [back, fore]
}

function distance(a: number, b: number) {
  const dr = ((a >> 16) & 255) - ((b >> 16) & 255)
  const dg = ((a >> 8) & 255) - ((b >> 8) & 255)
  const db = (a & 255) - (b & 255)

  return dr * dr * 2 + dg * dg * 4 + db * db * 3
}

// The bin as an animated SVG for the apps, in the terminal's quadrant pixels:
// one unit across, two down, so it matches what the terminal draws.
// A wide, shallow strip: it spans the band above the message box and the
// apps scale it to that width, so Scrooge gets a long pool to swim.
const SVG_SIZE: Size = { columns: 240, rows: 14, pixels: 'small' }
// The apps' interactive frame takes a default height (about 150 CSS pixels)
// unless given both a width and a height, and centres the strip in it. This
// is the strip's own shape (480 by 56 units) at a band about 750 wide; the
// width is held to the slot where the band is narrower.
const STRIP_WIDTH = 752
const STRIP_HEIGHT = Math.round((STRIP_WIDTH * 56) / 480)
const NONE = 0xffffffff
const SWIM_SPEED = 16 // pixels a second; the strip's lap is long.

// The board, the jump and the splash, before the swim begins.
const INTRO_SECONDS = 3

// The figures drawn in the strip's top right corner.
type Label = { text: string; colour: number }

function svgScene(percent: number, previous: number, isIntro: boolean, swimAge: number, label: Label) {
  const size = SVG_SIZE
  const layout = measure(size)
  const { width, height, ux } = layout
  const { standing, swim, submerged } = GRID[size.pixels].sprites
  const still = (shown: number): SceneState => ({
    target: shown,
    shown,
    phase: 'idle',
    t: 0,
    tick: 0,
    settle: 0,
    x: 0,
    dir: 1,
    particles: [],
  })
  const shown = percent / 100
  const empty = paint(still(0), size)
  const full = paint(still(shown), size)
  const coins = full.map((colour, i) => (colour === empty[i] ? NONE : colour))
  const surface = surfaceRow(layout, shown)
  const parts: string[] = [pixelPaths(empty, width)]

  // Scrooge sits between the bin and the coins, so the coins cover his lower half.
  if (percent >= diveAt) {
    const w = swim[0][0]!.length
    const top = surface - swim[0].length + submerged
    const start = jumpEnd(width) + w / 2
    const left = ux + w / 2
    const right = width - ux - w / 2
    // A later SVG starts the lap as far in as the swim has gone, so a redraw
    // for a new fill does not send Scrooge back to his start.
    const begin = isIntro ? INTRO_SECONDS : 0
    const lapBegin = isIntro ? `${INTRO_SECONDS}s` : `-${swimAge.toFixed(2)}s`

    if (isIntro) {
      parts.push(diveIntro(layout, standing, surface))
    }

    const d1 = (right - start) / SWIM_SPEED
    const d2 = (right - left) / SWIM_SPEED
    const d3 = (start - left) / SWIM_SPEED
    const total = d1 + d2 + d3
    const k1 = (d1 / total).toFixed(3)
    const k2 = ((d1 + d2) / total).toFixed(3)
    const kicks = [0, 0.45]
      .map(
        delay =>
          `<rect x="${-w / 2}" y="${swim[0].length - submerged - 1}" width="1" height="1" fill="${hex(GOLD[0]!)}" opacity="0">` +
          `<animateTransform attributeName="transform" type="translate" values="0 0;-3 -4;-6 0" dur="0.9s" begin="${begin + delay}s" repeatCount="indefinite"/>` +
          `<animate attributeName="opacity" values="1;1;0" dur="0.9s" begin="${begin + delay}s" repeatCount="indefinite"/></rect>`,
      )
      .join('')
    parts.push(
      `<g${isIntro ? ' visibility="hidden"' : ''}>` +
        (isIntro ? `<set attributeName="visibility" to="visible" begin="${begin}s"/>` : '') +
        `<g transform="translate(${start} ${top})">` +
        `<animateTransform attributeName="transform" type="translate" values="${start} ${top};${right} ${top};${left} ${top};${start} ${top}" keyTimes="0;${k1};${k2};1" dur="${total.toFixed(2)}s" begin="${lapBegin}" repeatCount="indefinite"/>` +
        `<g>` +
        `<animateTransform attributeName="transform" type="scale" values="1 1;-1 1;1 1" keyTimes="0;${k1};${k2}" calcMode="discrete" dur="${total.toFixed(2)}s" begin="${lapBegin}" repeatCount="indefinite"/>` +
        `<g>${spritePaths(swim[0], -w / 2)}<animate attributeName="opacity" values="1;0" calcMode="discrete" dur="0.6s" repeatCount="indefinite"/></g>` +
        `<g opacity="0">${spritePaths(swim[1], -w / 2)}<animate attributeName="opacity" values="0;1" calcMode="discrete" dur="0.6s" repeatCount="indefinite"/></g>` +
        kicks +
        `</g></g></g>`,
    )
  }

  // The coins, revealed from the old level up to the new one as they pour in.
  const isRising = percent > previous
  const oldTop = surfaceRow(layout, previous / 100) - 2
  const newTop = surface - 2
  parts.push(
    `<clipPath id="pile"><rect x="0" width="${width}" height="${height}" y="${isRising ? oldTop : newTop}">` +
      (isRising
        ? `<animate attributeName="y" from="${oldTop}" to="${newTop}" dur="1.5s" fill="freeze"/>`
        : '') +
      `</rect></clipPath>`,
    `<g clip-path="url(#pile)">${pixelPaths(coins, width)}</g>`,
  )

  if (isRising) {
    for (let i = 0; i < 24; i++) {
      const x = ux + Math.floor(Math.random() * (width - 3 * ux))
      const delay = (i * 0.06).toFixed(2)
      parts.push(
        `<rect x="${x}" y="1" width="${ux}" height="1" fill="${hex(GOLD[i % 2]!)}" opacity="0">` +
          `<animate attributeName="y" from="1" to="${newTop + 2}" dur="0.8s" begin="${delay}s" fill="freeze"/>` +
          `<animate attributeName="opacity" values="1;1;0" keyTimes="0;0.9;1" dur="0.8s" begin="${delay}s" fill="freeze"/></rect>`,
      )
    }
  }

  // A few sparkles on the pile.
  if (percent > 0) {
    const count = Math.max(6, Math.round(width / 40))
    for (let i = 0; i < count; i++) {
      const x = ux + Math.floor(((i + 0.5) / count) * (width - 2 * ux))
      parts.push(
        `<rect x="${x}" y="${surface}" width="1" height="1" fill="${hex(SPARKLE)}" opacity="0">` +
          `<animate attributeName="opacity" values="0;1;0" dur="1.6s" begin="${(i * 0.7).toFixed(1)}s" repeatCount="indefinite"/></rect>`,
      )
    }
  }

  // A quadrant pixel is twice as tall as it is wide: the scene is stretched to
  // that, the label is not. Drawn large, the apps scale it down to the band.
  const label_ =
    `<text x="${width - 3 * ux}" y="11" text-anchor="end" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" ` +
    `font-size="9" font-weight="700" fill="${hex(label.colour)}" stroke="${hex(INSIDE)}" stroke-width="3" ` +
    `paint-order="stroke" shape-rendering="auto">${escapeXml(label.text)}</text>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * 4}" height="${height * 8}" ` +
    `viewBox="0 0 ${width} ${height * 2}" shape-rendering="crispEdges">` +
    `<g transform="scale(1 2)">${parts.join('')}</g>` +
    label_ +
    `</svg>`
  )
}

// Scrooge on the board for 1.2s, then the arc into the coins, flipping head
// first after its peak, and the splash.
function diveIntro(layout: Layout, standing: Sprite, surface: number) {
  const { board, width, ux } = layout
  const w = standing[0]!.length
  const h = standing.length
  const points: string[] = []
  for (let i = 0; i <= 12; i++) {
    const p = i / 12
    const x = ux + p * (jumpEnd(width) - ux) + w / 2
    const feet = board - 1 + p * (surface + h - board) - Math.sin(p * Math.PI) * 5
    points.push(`${x.toFixed(1)} ${(feet - h + 1).toFixed(1)}`)
  }
  const upright = spritePaths(standing, -w / 2)
  const splash: string[] = []
  for (let i = 0; i < 16; i++) {
    const vx = ((i / 15 - 0.5) * 1.6 * ux).toFixed(2)
    const rise = (6 + (i % 5) * 2).toFixed(0)
    splash.push(
      `<rect x="${jumpEnd(width) + w / 2}" y="${surface - 1}" width="1" height="1" fill="${hex(i % 3 === 0 ? GLINT : GOLD[i % 2]!)}" opacity="0">` +
        `<animateTransform attributeName="transform" type="translate" values="0 0;${Number(vx) * 4} -${rise};${Number(vx) * 8} 0" dur="0.8s" begin="2.4s" fill="freeze"/>` +
        `<animate attributeName="opacity" values="1;1;0" dur="0.8s" begin="2.4s" fill="freeze"/></rect>`,
    )
  }

  return (
    `<g transform="translate(${ux + w / 2} ${board - h})"><set attributeName="visibility" to="hidden" begin="1.2s"/>${upright}</g>` +
    `<g visibility="hidden" transform="translate(${points[0]})">` +
    `<set attributeName="visibility" to="visible" begin="1.2s"/><set attributeName="visibility" to="hidden" begin="2.4s"/>` +
    `<animateTransform attributeName="transform" type="translate" values="${points.join(';')}" dur="1.2s" begin="1.2s" fill="freeze"/>` +
    `<g>${upright}<animate attributeName="opacity" values="1;0" keyTimes="0;0.5" calcMode="discrete" dur="1.2s" begin="1.2s" fill="freeze"/></g>` +
    `<g opacity="0" transform="translate(0 ${h}) scale(1 -1)">${upright}<animate attributeName="opacity" values="0;1" keyTimes="0;0.5" calcMode="discrete" dur="1.2s" begin="1.2s" fill="freeze"/></g>` +
    `</g>` +
    splash.join('')
  )
}

// One path per colour, each run of a row one rectangle; NONE is left out.
function pixelPaths(px: Uint32Array, width: number) {
  const runs = new Map<number, string[]>()
  const height = px.length / width
  for (let y = 0; y < height; y++) {
    let x = 0
    while (x < width) {
      const colour = px[y * width + x]!
      let end = x + 1
      while (end < width && px[y * width + end] === colour) end++
      if (colour !== NONE) {
        const list = runs.get(colour) ?? []
        list.push(`M${x} ${y}h${end - x}v1h${x - end}z`)
        runs.set(colour, list)
      }
      x = end
    }
  }

  return [...runs].map(([colour, d]) => `<path fill="${hex(colour)}" d="${d.join('')}"/>`).join('')
}

function spritePaths(sprite: Sprite, left: number) {
  const runs = new Map<string, string[]>()
  sprite.forEach((line, y) => {
    let x = 0
    while (x < line.length) {
      const key = line[x]!
      let end = x + 1
      while (end < line.length && line[end] === key) end++
      if (PALETTE[key] !== undefined) {
        const list = runs.get(key) ?? []
        list.push(`M${left + x} ${y}h${end - x}v1h${x - end}z`)
        runs.set(key, list)
      }
      x = end
    }
  })

  return [...runs].map(([key, d]) => `<path fill="${hex(PALETTE[key]!)}" d="${d.join('')}"/>`).join('')
}

function escapeXml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function hex(colour: number) {
  return `#${colour.toString(16).padStart(6, '0')}`
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!
    out += b === undefined ? '=' : ALPHABET[(n >> 6) & 63]!
    out += c === undefined ? '=' : ALPHABET[n & 63]!
  }

  return out
}

function hash(x: number, y: number) {
  const h = (Math.imul(x | 0, 73856093) ^ Math.imul(Math.floor(y), 19349663)) >>> 0

  return (h ^ (h >>> 13)) >>> 0
}

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, value))
}

function tokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`

  return String(n)
}
