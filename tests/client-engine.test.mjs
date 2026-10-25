/**
 * Unit tests for the notification engine, preference document, permission
 * store, tone player, and dispatcher. The Client bundle runs inside a sandbox
 * that mirrors the browser module contract (see `harness.mjs`).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAudioContextClass,
  createClientContext,
  createNotificationClass,
  createStorage,
  loadBundle,
} from './harness.mjs'

/** Dictionary used by the engine tests; mirrors the bundle's own English keys. */
const TEMPLATES = {
  'title.complete': '{session} finished',
  'title.action': '{session} needs you',
  'title.error': '{session} failed',
  'body.complete': 'The agent finished this turn.',
  'body.error': '{message}',
  'body.action.approval': '{tool} is waiting for your approval.',
  'body.action.question': '{question}',
  'body.action.planReview': 'A plan is waiting for your review.',
}

/**
 * Translate one template key with the given parameters.
 * @param key - template key.
 * @param params - interpolation values.
 * @returns the rendered text.
 */
function translate(key, params) {
  const template = TEMPLATES[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  )
}

/**
 * Build an engine wired to a recording delivery function.
 * @param bundle - loaded bundle internals.
 * @param option - store, visibility, clock, and session facts overrides.
 * @returns the engine plus the recorded alerts.
 */
function buildEngine(bundle, option = {}) {
  const store = option.store ?? bundle.createSettingsStore(option.storage)
  const delivered = []
  let clock = option.now ?? 1_000
  const engine = bundle.createEngine({
    store,
    environment: {
      isHidden: option.isHidden ?? (() => true),
      now: () => clock,
      describe: option.describe ?? (() => ({ title: 'Alpha', subagent: false })),
      t: translate,
      deliver: (request) => {
        delivered.push(request)
        return { shown: true, sounded: true }
      },
    },
  })
  return {
    engine,
    delivered,
    store,
    advance(ms) {
      clock += ms
    },
  }
}

/**
 * Build one Session status snapshot.
 * @param entries - `[sessionId, status]` pairs.
 * @returns the map the Client Session plugin publishes.
 */
function snapshot(entries) {
  return new Map(entries)
}

/** Status of an idle Session. */
const idle = (extra = {}) => ({ running: false, pendingInteraction: undefined, completionUnread: false, ...extra })

/** Status of a running Session. */
const running = (extra = {}) => ({ running: true, pendingInteraction: undefined, completionUnread: false, ...extra })

test('preferences: defaults survive a missing or corrupt document', () => {
  const bundle = loadBundle().internals
  assert.deepEqual({ ...bundle.normalizeSettings(undefined) }, { ...bundle.DEFAULTS })

  const corrupt = createStorage({ [bundle.STORAGE_KEY]: '{not json' })
  assert.deepEqual({ ...bundle.createSettingsStore(corrupt).getSnapshot() }, { ...bundle.DEFAULTS })

  const partial = bundle.normalizeSettings({
    enabled: false,
    volume: 500,
    soundComplete: 'nope',
    soundAction: 'marimba',
    soundError: undefined,
  })
  assert.equal(partial.enabled, false)
  assert.equal(partial.volume, 100)
  assert.equal(partial.soundComplete, bundle.DEFAULTS.soundComplete, 'an unsupported tone reverts to that kind only')
  assert.equal(partial.soundAction, 'marimba')
  assert.equal(partial.soundError, bundle.DEFAULTS.soundError)
})

test('preferences: writes persist and unsupported fields are dropped', () => {
  const bundle = loadBundle().internals
  const storage = createStorage()
  const store = bundle.createSettingsStore(storage)
  let notifications = 0
  store.subscribe(() => {
    notifications += 1
  })

  store.update({ soundError: 'harp', volume: -20, extra: 'ignored' })
  assert.equal(store.getSnapshot().soundError, 'harp')
  assert.equal(store.getSnapshot().volume, 0)
  assert.equal(notifications, 1)

  const stored = JSON.parse(storage.dump()[bundle.STORAGE_KEY])
  assert.equal(stored.soundError, 'harp')
  assert.equal(stored.sound, undefined, 'the single-tone field is gone')
  assert.equal(stored.extra, undefined)

  store.update({ soundError: 'harp' })
  assert.equal(notifications, 1, 'an unchanged document must not publish')

  const reopened = bundle.createSettingsStore(storage).getSnapshot()
  assert.equal(reopened.soundError, 'harp')
})

test('preferences: an unusable storage keeps the page working in memory', () => {
  const bundle = loadBundle().internals
  const storage = createStorage()
  storage.failWrites = true
  const store = bundle.createSettingsStore(storage)
  store.update({ soundComplete: 'marimba' })
  assert.equal(store.getSnapshot().soundComplete, 'marimba')
})

test('engine: the first snapshot is a baseline and never alerts', () => {
  const bundle = loadBundle().internals
  const { engine, delivered } = buildEngine(bundle)
  assert.deepEqual(engine.applyStatus(snapshot([['a', running()]])), [])
  assert.equal(delivered.length, 0)
})

test('engine: a running to idle transition raises one completion alert', () => {
  const bundle = loadBundle().internals
  const { engine, delivered } = buildEngine(bundle)
  engine.applyStatus(snapshot([['a', running()]]))
  const raised = engine.applyStatus(snapshot([['a', idle()]]))
  assert.equal(raised.length, 1)
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].kind, 'complete')
  assert.equal(delivered[0].title, 'Alpha finished')
  assert.equal(delivered[0].body, 'The agent finished this turn.')
  assert.equal(delivered[0].tag, 'dsh:a:complete')
  assert.equal(delivered[0].sessionId, 'a')
  assert.equal(delivered[0].sound, bundle.DEFAULTS.soundComplete)
})

test('engine: each alert kind plays its own tone at the shared volume', () => {
  const bundle = loadBundle().internals
  const { engine, delivered } = buildEngine(bundle)

  engine.applyStatus(snapshot([['a', running()], ['b', running()], ['c', running()]]))
  engine.applyStatus(snapshot([['a', idle()], ['b', idle()], ['c', idle()]]))
  engine.applyStatus(
    snapshot([
      ['a', running({ pendingInteraction: { key: 'approval:a:1', kind: 'approval', sessionId: 'a', toolName: 'bash' } })],
      ['b', idle()],
      ['c', idle()],
    ]),
  )
  engine.reportError('c', 'boom')

  const byKind = Object.fromEntries(delivered.map((request) => [request.kind, request]))
  assert.equal(byKind.complete.sound, bundle.DEFAULTS.soundComplete)
  assert.equal(byKind.action.sound, bundle.DEFAULTS.soundAction)
  assert.equal(byKind.error.sound, bundle.DEFAULTS.soundError)
  assert.equal(
    new Set([byKind.complete.sound, byKind.action.sound, byKind.error.sound]).size,
    3,
    'the three kinds must be distinguishable by ear out of the box',
  )
  assert.deepEqual(
    [...new Set(delivered.map((request) => request.volume))],
    [bundle.DEFAULTS.volume],
    'volume stays shared across kinds',
  )

  /* A stored preference wins over the default, per kind and independently. */
  const customStore = bundle.createSettingsStore(createStorage())
  customStore.update({ soundComplete: 'soft', soundAction: 'none', soundError: 'marimba' })
  const custom = buildEngine(bundle, { store: customStore })
  custom.engine.applyStatus(snapshot([['a', running()]]))
  custom.engine.applyStatus(snapshot([['a', idle()]]))
  assert.equal(custom.delivered[0].sound, 'soft')
})

test('engine: a pending approval raises one action alert with the tool name', () => {
  const bundle = loadBundle().internals
  const { engine, delivered } = buildEngine(bundle)
  const approval = { key: 'approval:a:1', kind: 'approval', sessionId: 'a', toolName: 'bash' }
  engine.applyStatus(snapshot([['a', running()]]))
  const raised = engine.applyStatus(snapshot([['a', running({ pendingInteraction: approval })]]))
  assert.equal(raised.length, 1)
  assert.equal(delivered[0].kind, 'action')
  assert.equal(delivered[0].interactionKind, 'approval')
  assert.equal(delivered[0].title, 'Alpha needs you')
  assert.equal(delivered[0].body, 'bash is waiting for your approval.')

  assert.equal(engine.applyStatus(snapshot([['a', running({ pendingInteraction: approval })]])).length, 0)

  const second = { key: 'approval:a:2', kind: 'approval', sessionId: 'a', toolName: 'write' }
  assert.equal(engine.applyStatus(snapshot([['a', running({ pendingInteraction: second })]])).length, 1)
  assert.equal(delivered[1].body, 'write is waiting for your approval.')
})

test('engine: a question alert carries its text, and a plan review its own copy', () => {
  const bundle = loadBundle().internals
  const { engine, delivered } = buildEngine(bundle)
  engine.applyStatus(snapshot([['a', running()]]))
  engine.applyStatus(
    snapshot([
      [
        'a',
        running({
          pendingInteraction: {
            key: 'question:a:1',
            kind: 'question',
            sessionId: 'a',
            questions: [{ id: 'q', question: 'Which branch?' }],
          },
        }),
      ],
    ]),
  )
  assert.equal(delivered[0].interactionKind, 'question')
  assert.equal(delivered[0].body, 'Which branch?')

  engine.applyStatus(
    snapshot([
      ['a', running({ pendingInteraction: { key: 'plan:a:1', kind: 'plan-review', sessionId: 'a' } })],
    ]),
  )
  assert.equal(delivered[1].interactionKind, 'plan-review')
  assert.equal(delivered[1].body, 'A plan is waiting for your review.')
})

test('engine: stopping while a new interaction appears only raises the action alert', () => {
  const bundle = loadBundle().internals
  const { engine, delivered } = buildEngine(bundle)
  engine.applyStatus(snapshot([['a', running()]]))
  engine.applyStatus(
    snapshot([
      [
        'a',
        {
          running: false,
          pendingInteraction: { key: 'question:a:9', kind: 'question', sessionId: 'a', questions: [] },
          completionUnread: true,
        },
      ],
    ]),
  )
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].kind, 'action')
})

test('engine: repeated transitions inside the suppression window are dropped', () => {
  const bundle = loadBundle().internals
  const { engine, delivered, advance } = buildEngine(bundle)
  engine.applyStatus(snapshot([['a', running()]]))
  engine.applyStatus(snapshot([['a', idle()]]))
  assert.equal(delivered.length, 1)

  engine.applyStatus(snapshot([['a', running()]]))
  engine.applyStatus(snapshot([['a', idle()]]))
  assert.equal(delivered.length, 1, 'a second completion inside the window stays silent')

  advance(bundle.DEDUPE_MS + 1)
  engine.applyStatus(snapshot([['a', running()]]))
  engine.applyStatus(snapshot([['a', idle()]]))
  assert.equal(delivered.length, 2, 'after the window the alert returns')
})

test('engine: the visibility preference gates every kind', () => {
  const bundle = loadBundle().internals
  const visible = buildEngine(bundle, { isHidden: () => false })
  visible.engine.applyStatus(snapshot([['a', running()]]))
  visible.engine.applyStatus(snapshot([['a', idle()]]))
  assert.equal(visible.delivered.length, 0)

  visible.store.update({ onlyWhenHidden: false })
  visible.engine.applyStatus(snapshot([['a', running()]]))
  visible.engine.applyStatus(snapshot([['a', idle()]]))
  assert.equal(visible.delivered.length, 1)
})

test('plugin: a visible but unfocused window still counts as background', () => {
  const Notification = createNotificationClass('granted')
  const bundle = loadBundle({
    storage: createStorage(),
    Notification,
    visibilityState: 'visible',
    hasFocus: () => false,
  })
  const context = createClientContext({ statusSnapshot: new Map() })
  bundle.exports.apply(context.ctx)

  context.setStatus(new Map([['s1', { running: true, pendingInteraction: undefined, completionUnread: false }]]))
  context.setStatus(new Map([['s1', { running: false, pendingInteraction: undefined, completionUnread: true }]]))
  assert.equal(Notification.created.length, 1, 'another app in front must not swallow the alert')

  const focused = loadBundle({
    storage: createStorage(),
    Notification: createNotificationClass('granted'),
    visibilityState: 'visible',
    hasFocus: () => true,
  })
  const focusedContext = createClientContext({ statusSnapshot: new Map() })
  focused.exports.apply(focusedContext.ctx)
  focusedContext.setStatus(new Map([['s1', { running: true, pendingInteraction: undefined, completionUnread: false }]]))
  focusedContext.setStatus(new Map([['s1', { running: false, pendingInteraction: undefined, completionUnread: true }]]))
  assert.equal(focused.window.Notification.created.length, 0, 'the attended page stays quiet')
})

test('engine: each event toggle and the master switch silence their own kind', () => {
  const bundle = loadBundle().internals
  const { engine, delivered, store } = buildEngine(bundle)

  store.update({ notifyOnComplete: false, notifyOnAction: false, notifyOnError: false })
  engine.applyStatus(snapshot([['a', running()]]))
  engine.applyStatus(snapshot([['a', idle()]]))
  engine.reportError('a', 'boom')
  assert.equal(delivered.length, 0)

  store.update({ notifyOnComplete: true, notifyOnAction: true, notifyOnError: true })
  engine.applyStatus(snapshot([['a', running()]]))
  engine.applyStatus(snapshot([['a', idle()]]))
  assert.equal(delivered.length, 1)

  store.update({ enabled: false })
  engine.applyStatus(snapshot([['a', running()]]))
  engine.applyStatus(snapshot([['a', idle()]]))
  assert.equal(delivered.length, 1, 'the master switch stops everything')
})

test('engine: subagents stay silent unless included, but a child gate always alerts', () => {
  const bundle = loadBundle().internals
  const child = buildEngine(bundle, { describe: () => ({ title: 'Child', subagent: true }) })
  child.engine.applyStatus(snapshot([['c', running()]]))
  child.engine.applyStatus(snapshot([['c', idle()]]))
  assert.equal(child.delivered.length, 0)

  child.store.update({ includeSubagents: true })
  child.engine.applyStatus(snapshot([['c', running()]]))
  child.engine.applyStatus(snapshot([['c', idle()]]))
  assert.equal(child.delivered.length, 1)

  const blocked = buildEngine(bundle, { describe: () => ({ title: 'Child', subagent: true }) })
  blocked.engine.applyStatus(snapshot([['c', running()]]))
  blocked.engine.applyStatus(
    snapshot([['c', running({ pendingInteraction: { key: 'approval:c:1', kind: 'approval', sessionId: 'c' } })]]),
  )
  assert.equal(blocked.delivered.length, 1, 'an approval on a child must never be hidden')
  assert.equal(blocked.delivered[0].kind, 'action')
})

test('engine: errors are truncated to one line and deduplicated per session', () => {
  const bundle = loadBundle().internals
  const { engine, delivered } = buildEngine(bundle)
  engine.reportError('a', `line one\nline two ${'x'.repeat(400)}`)
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].kind, 'error')
  assert.equal(delivered[0].title, 'Alpha failed')
  assert.ok(!delivered[0].body.includes('\n'), 'the body must stay on one line')
  assert.ok(Array.from(delivered[0].body).length <= 200, 'the body must be bounded')

  engine.reportError('a', 'again')
  assert.equal(delivered.length, 1)

  engine.reportError('b', 'other session')
  assert.equal(delivered.length, 2)
})

test('engine: a failure folds the trailing completion alert into itself', () => {
  const bundle = loadBundle().internals
  const { engine, delivered, advance } = buildEngine(bundle)
  engine.applyStatus(snapshot([['a', running()]]))
  engine.reportError('a', 'provider exploded')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].kind, 'error')

  engine.applyStatus(snapshot([['a', idle()]]))
  assert.equal(delivered.length, 1, 'the stop caused by the failure must not alert twice')

  engine.applyStatus(snapshot([['a', running()]]))
  advance(bundle.DEDUPE_MS + 1)
  engine.applyStatus(snapshot([['a', idle()]]))
  assert.equal(delivered.length, 2)
})

test('engine: a removed session is re-baselined instead of completing', () => {
  const bundle = loadBundle().internals
  const { engine, delivered } = buildEngine(bundle)
  engine.applyStatus(snapshot([['a', running()]]))
  engine.applyStatus(snapshot([]))
  engine.applyStatus(snapshot([['a', running()]]))
  assert.equal(delivered.length, 0)
  engine.applyStatus(snapshot([['a', idle()]]))
  assert.equal(delivered.length, 1)
})

test('engine: reset clears the baseline so a reconnect never storms alerts', () => {
  const bundle = loadBundle().internals
  const { engine, delivered } = buildEngine(bundle)
  engine.applyStatus(snapshot([['a', running()]]))
  engine.reset()
  engine.applyStatus(snapshot([['a', idle()]]))
  assert.equal(delivered.length, 0)
})

test('sound: presets are sine voices with a struck-string envelope', () => {
  const bundle = loadBundle().internals

  const Audio = createAudioContextClass()
  const player = bundle.createSoundPlayer({ createContext: () => new Audio() })
  assert.equal(player.play('chime', 60), true)
  const context = Audio.contexts[0]

  /* Two struck notes, each with its own oscillator per partial. */
  assert.deepEqual(context.started.map((entry) => Math.round(entry.freq * 100) / 100), [659.25, 1318.5, 1977.75, 880, 1760])
  assert.ok(
    context.started.every((entry) => entry.type === 'sine'),
    'no square or triangle voice: those read as mechanical beeps',
  )
  for (const entry of context.started) {
    assert.ok(entry.until - entry.at >= 0.5, 'every voice has a long decay, not a blip')
  }

  /* The envelope must ramp up from silence and then fall away exponentially,
   * which is what removes the click of a hard start. */
  for (const envelope of context.envelopes) {
    assert.equal(envelope[0][0], 'set')
    assert.equal(envelope[0][1], 0)
    assert.equal(envelope[1][0], 'linear')
    assert.ok(envelope[1][2] > envelope[0][2], 'attack moves forward in time')
    assert.equal(envelope[2][0], 'exponential')
    assert.ok(envelope[2][1] < envelope[1][1], 'decay ends quieter than the peak')
  }

  assert.equal(player.play('none', 60), false)
  assert.equal(player.play('unknown', 60), false)
  assert.equal(player.play('soft', 0), false, 'zero volume schedules nothing')

  const quieter = bundle.createSoundPlayer({ createContext: () => new Audio() })
  assert.equal(quieter.play('harp', 30), true)
  assert.equal(Audio.contexts[1].started.length, 6, 'three notes with one octave partial each')

  /* These presets are meant to stay gentle: at 30% the peak of the loudest
   * partial stays under a twentieth of full scale, and the level scales with
   * the requested volume instead of jumping. */
  const quietPeak = Audio.contexts[1].envelopes[0][1][1]
  assert.ok(quietPeak <= 0.05, `peak gain ${quietPeak} stays soft`)

  const halfAudio = createAudioContextClass()
  const half = bundle.createSoundPlayer({ createContext: () => new halfAudio() })
  assert.equal(half.play('soft', 30), true)
  const halfPeak = halfAudio.contexts[0].envelopes[0][1][1]

  const fullAudio = createAudioContextClass()
  const full = bundle.createSoundPlayer({ createContext: () => new fullAudio() })
  assert.equal(full.play('soft', 100), true)
  const fullPeak = fullAudio.contexts[0].envelopes[0][1][1]
  assert.ok(fullPeak <= 0.2, `full-volume peak ${fullPeak} still leaves headroom`)
  assert.ok(
    Math.abs(fullPeak / halfPeak - 100 / 30) < 0.2,
    'volume is linear, so a slider move is a proportion, not a jump',
  )
})

test('sound: a suspended context still schedules its notes so the first alert is audible', () => {
  const bundle = loadBundle().internals

  /* Chrome's autoplay policy leaves the context suspended until a gesture. Notes
   * queued before `resume()` resolves still play, so the player must schedule
   * first and resume second; awaiting the resume first is what dropped the alert
   * after a tab sat idle long enough to be re-suspended. */
  const Audio = createAudioContextClass({ state: 'suspended' })
  const player = bundle.createSoundPlayer({ createContext: () => new Audio() })
  assert.equal(player.play('chime', 60), true)
  assert.equal(Audio.contexts[0].started.length, 5, 'notes are already queued')
  assert.equal(Audio.contexts[0].resumed, 1, 'and the resume was requested')
  assert.equal(Audio.contexts[0].state, 'running')
})

test('sound: a refused resume reports blocked without pretending the tone played', async () => {
  const bundle = loadBundle().internals

  class StubbornAudio extends createAudioContextClass({ state: 'suspended' }) {
    async resume() {
      this.resumed += 1
      throw new Error('gesture required')
    }
  }
  const player = bundle.createSoundPlayer({ createContext: () => new StubbornAudio() })
  assert.equal(player.state(), 'pending', 'a fresh suspended context is pending, not refused')
  player.play('chime', 60)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(player.state(), 'blocked', 'a rejected resume stays blocked')

  player.wake()
  await Promise.resolve()
  assert.equal(player.state(), 'blocked', 'a second refusal is still reported')
})

test('sound: a running context never claims to be blocked', () => {
  const bundle = loadBundle().internals
  const Audio = createAudioContextClass({ state: 'running' })
  const player = bundle.createSoundPlayer({ createContext: () => new Audio() })
  assert.equal(player.state(), 'ready')
  assert.equal(player.wake(), 'ready')
  assert.equal(player.play('soft', 40), true)
  assert.equal(player.state(), 'ready', 'scheduling never flips a working context to blocked')
})

test('sound: an unavailable browser never throws and never blocks notifications', () => {
  const bundle = loadBundle().internals
  const broken = bundle.createSoundPlayer({
    createContext: () => {
      throw new Error('no audio')
    },
  })
  assert.equal(broken.unlock(), false)
  assert.equal(broken.play('chime', 50), false)

  const missing = bundle.createSoundPlayer({ createContext: () => undefined })
  assert.equal(missing.play('harp', 50), false)
})

test('dispatcher: notifications need permission, tones do not', () => {
  const bundle = loadBundle().internals
  const Notification = createNotificationClass('default')
  const permission = bundle.createPermissionStore({ globalObject: { Notification } })
  const played = []
  const dispatcher = bundle.createDispatcher({
    permission: () => permission.getSnapshot().permission,
    notify: (title, options) => permission.construct(title, options),
    play: (sound, volume) => {
      played.push([sound, volume])
      return true
    },
    focus: () => {},
    openSession: () => {},
  })

  const blocked = dispatcher.deliver({
    title: 'T',
    body: 'B',
    tag: 'dsh:x:complete',
    sessionId: 'x',
    sound: 'chime',
    volume: 40,
  })
  assert.deepEqual(blocked, { shown: false, sounded: true })
  assert.equal(Notification.created.length, 0)
  assert.deepEqual(played, [['chime', 40]])

  Notification.setPermission('granted')
  permission.refresh()
  assert.equal(permission.getSnapshot().permission, 'granted')

  let opened
  let focused = 0
  const granted = bundle.createDispatcher({
    permission: () => permission.getSnapshot().permission,
    notify: (title, options) => permission.construct(title, options),
    play: () => false,
    focus: () => {
      focused += 1
    },
    openSession: (sessionId) => {
      opened = sessionId
    },
  })
  const shown = granted.deliver({
    title: 'T',
    body: 'B',
    tag: 'dsh:x:complete',
    sessionId: 'x',
    sound: 'none',
    volume: 0,
  })
  assert.deepEqual(shown, { shown: true, sounded: false })
  assert.equal(Notification.created[0].title, 'T')
  assert.equal(Notification.created[0].options.silent, true)

  Notification.created[0].onclick()
  assert.equal(focused, 1)
  assert.equal(opened, 'x')
})

test('permission: an unsupported browser reports itself instead of throwing', async () => {
  const bundle = loadBundle().internals
  const store = bundle.createPermissionStore({ globalObject: {} })
  assert.deepEqual(store.getSnapshot(), { supported: false, permission: 'unsupported' })
  assert.equal(await store.request(), 'unsupported')
  assert.equal(store.construct('T', {}), undefined)
})

test('plugin: apply registers dictionaries, styles, listeners, and the settings page', () => {
  const Notification = createNotificationClass('granted')
  const Audio = createAudioContextClass()
  const bundle = loadBundle({
    storage: createStorage(),
    Notification,
    AudioContext: Audio,
    visibilityState: 'hidden',
  })
  const context = createClientContext()

  bundle.exports.apply(context.ctx)

  assert.equal(typeof bundle.exports.apply, 'function')
  assert.deepEqual(bundle.exports.inject, ['locale', 'slots', 'sessions', 'uiSession', 'remote'])

  const dictionaries = context.localeNamespaces.get('agentNotifications')
  assert.ok(dictionaries.en['page.title'], 'the English dictionary is registered')
  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.zh).sort())

  assert.equal(context.slotRegistrations.length, 1)
  const registration = context.slotRegistrations[0]
  assert.equal(registration.options.name, 'settings.section')
  assert.equal(registration.options.id, 'agent-notifications')
  assert.equal(registration.options.order, 30)
  assert.deepEqual(context.injections, ['settings.section'])

  const face = registration.options.inject()
  assert.equal(typeof face.setSetting, 'function')
  assert.equal(typeof face.requestPermission, 'function')
  assert.equal(typeof face.previewTone, 'function')
  assert.equal(typeof face.sendTestNotification, 'function')
  assert.equal(typeof face.hooks.settings.getSnapshot, 'function')
  assert.equal(typeof face.hooks.permission.getSnapshot, 'function')

  assert.equal(bundle.styles.length, 1)
  assert.match(bundle.styles[0].textContent, /dsh-notify-section/)
  assert.equal(context.statusListenerCount(), 1)
  assert.equal(context.remoteListeners.filter((entry) => entry.event === 'api-session/error').length, 1)

  context.disposeAll()
  assert.equal(context.statusListenerCount(), 0)
  assert.equal(context.remoteListeners.length, 0)
  assert.equal(bundle.styles.length, 0)
  assert.ok(Audio.contexts.every((audio) => audio.closed > 0 || audio.resumed === 0))
})

test('plugin: live status and error events deliver notifications end to end', () => {
  const Notification = createNotificationClass('granted')
  const Audio = createAudioContextClass()
  const bundle = loadBundle({
    storage: createStorage(),
    Notification,
    AudioContext: Audio,
    visibilityState: 'hidden',
  })
  const store = bundle.internals.createSettingsStore(undefined)
  const sessions = {
    list: {
      getSnapshot: () => ({
        ids: ['s1'],
        byId: { s1: { displayTitle: 'Release checklist', running: true } },
        phase: 'ready',
        projectionsBySession: {},
      }),
    },
  }
  const context = createClientContext({ sessions, statusSnapshot: new Map() })

  // Publish through the plugin's own store and status source by mounting apply.
  bundle.exports.apply(context.ctx)

  const first = new Map([['s1', { running: true, pendingInteraction: undefined, completionUnread: false }]])
  context.setStatus(first)
  assert.equal(Notification.created.length, 0, 'the first snapshot is a baseline')

  context.setStatus(new Map([['s1', { running: false, pendingInteraction: undefined, completionUnread: true }]]))
  assert.equal(Notification.created.length, 1)
  assert.equal(Notification.created[0].title, 'Release checklist finished')

  context.setStatus(new Map([['s1', { running: true, pendingInteraction: undefined, completionUnread: false }]]))
  context.emitError('s1', 'provider exploded')
  assert.equal(Notification.created.length, 2)
  assert.match(Notification.created[1].title, /failed$/)
  assert.equal(Notification.created[1].options.body, 'provider exploded')

  context.disposeAll()
  assert.ok(store.getSnapshot().enabled)
})
