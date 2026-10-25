/**
 * Settings-page tests: the section renders the documented controls, reflects
 * the stored preferences, and calls the plugin's own operations.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  byType,
  createClientContext,
  createNotificationClass,
  createPrimitives,
  createStorage,
  flatten,
  loadBundle,
} from './harness.mjs'

/**
 * Load the bundle and return its internals plus a translator over its English
 * dictionary.
 * @param permission - browser permission to simulate.
 * @param option - extra bundle options, such as the primitives module.
 * @returns the fixtures.
 */
function setup(permission = 'granted', option = {}) {
  const Notification = createNotificationClass(permission)
  const bundle = loadBundle({ storage: createStorage(), Notification, ...option })
  const internals = bundle.internals
  const t = (key, params) => {
    const template = internals.dictionaries.en[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
    )
  }
  const settings = internals.createSettingsStore(bundle.window.localStorage)
  const permissionStore = internals.createPermissionStore({ globalObject: bundle.window })
  return { bundle, internals, t, settings, permissionStore, Notification }
}

/** The primitive library every Web profile ships, as the harness models it. */
const PRIMITIVES = createPrimitives()

/**
 * Render the settings section with the plugin's own operation stubs.
 * @param fixtures - from {@link setup}.
 * @param option - operation overrides.
 * @returns the rendered element tree plus the recorded operations.
 */
function render(fixtures, option = {}) {
  const calls = { setSetting: [], requestPermission: 0, previewTone: [], sendTestNotification: 0 }
  let testResult = { shown: true, sounded: true }
  let audioState = 'ready'
  const tree = fixtures.internals.NotificationsView({
    t: fixtures.t,
    useSettings: (selector) => selector(fixtures.settings.getSnapshot()),
    usePermission: (selector) => selector(fixtures.permissionStore.getSnapshot()),
    setSetting: (field, value) => {
      calls.setSetting.push([field, value])
      fixtures.settings.update({ [field]: value })
    },
    requestPermission: async () => {
      calls.requestPermission += 1
      return 'granted'
    },
    previewTone: (presetId) => {
      calls.previewTone.push(presetId)
      return { played: presetId !== 'none', state: audioState }
    },
    sendTestNotification: () => {
      calls.sendTestNotification += 1
      return testResult
    },
    ...option,
  })
  return {
    tree,
    calls,
    setTestResult: (next) => { testResult = next },
    setAudioState: (next) => { audioState = next },
  }
}

/**
 * Collect the text content of an element tree.
 * @param tree - rendered tree.
 * @returns all string leaves in document order.
 */
function texts(tree) {
  return flatten(tree)
    .flatMap((element) => element.children)
    .filter((child) => typeof child === 'string')
}

test('settings page: renders the heading, the master switch, and one group per concern', () => {
  const fixtures = setup()
  const { tree } = render(fixtures)

  assert.deepEqual(byType(tree, 'h2').map((element) => element.children.join('')), ['Notifications'])

  const switches = byType(tree, 'primitive-switch')
  assert.equal(switches.length, 6, 'master + three events + two scope rows')
  assert.deepEqual(
    switches.map((element) => element.props.label),
    [
      'Enable notifications',
      'Turn finished',
      'Action needed',
      'Turn failed',
      'Only while this page is in the background',
      'Include subagents',
    ],
  )
})

test('settings page: each event switch owns its tone, merged into one section', () => {
  const fixtures = setup()
  const { tree, calls } = render(fixtures)

  /* Switches and pickers share one group: an outcome is a single decision, not
   * a "when" switch in one place and a "what sound" picker in another. */
  const groups = flatten(tree).filter((element) => element.props?.role === 'group')
  assert.deepEqual(
    groups.map((element) => byType(element, 'h3')[0].children.join('')),
    ['When to notify', 'Scope', 'Try it'],
  )
  const events = groups[0]
  assert.equal(byType(events, 'primitive-switch').length, 3, 'one switch per outcome')
  assert.equal(byType(events, 'primitive-menu').length, 3, 'and one picker per outcome, inside the same group')

  const menus = byType(tree, 'primitive-menu')
  assert.deepEqual(
    menus.map((menu) => menu.props.selectedId),
    ['chime', 'harp', 'droplet'],
    'the three defaults stay distinct',
  )
  assert.deepEqual(
    menus.map((menu) => menu.props.anchor.props.id),
    ['dsh-notify-sound-complete', 'dsh-notify-sound-action', 'dsh-notify-sound-error'],
  )
  assert.deepEqual(
    menus.map((menu) => menu.props.anchor.props['aria-label']),
    ['Turn finished', 'Action needed', 'Turn failed'],
  )
  assert.deepEqual(
    byType(menus[0], 'option').map((option) => option.props.value).concat([]),
    [],
    'a Menu has no option children of its own',
  )
  assert.deepEqual(
    menus[0].props.items.map((item) => item.label),
    ['None', 'Soft', 'Chime', 'Marimba', 'Harp arpeggio', 'Droplet'],
  )

  menus[2].props.onSelect('soft')
  assert.deepEqual(calls.setSetting.at(-1), ['soundError', 'soft'])
  menus[0].props.onSelect('marimba')
  assert.deepEqual(calls.setSetting.at(-1), ['soundComplete', 'marimba'])
})

test('settings page: toggling an event switch writes that preference', () => {
  const fixtures = setup()
  const { tree, calls } = render(fixtures)
  const switches = byType(tree, 'primitive-switch')

  switches[1].props.onChange(false)
  assert.deepEqual(calls.setSetting[0], ['notifyOnComplete', false])
  assert.equal(fixtures.settings.getSnapshot().notifyOnComplete, false)

  switches[5].props.onChange(true)
  assert.deepEqual(calls.setSetting[1], ['includeSubagents', true])
})

test('settings page: an off switch hides its tone row entirely', () => {
  const fixtures = setup()
  fixtures.settings.update({ notifyOnError: false })
  const { tree } = render(fixtures)

  assert.equal(byType(tree, 'primitive-menu').length, 2, 'the failed outcome has no tone to set')
  assert.deepEqual(
    byType(tree, 'primitive-menu').map((menu) => menu.props.anchor.props.id),
    ['dsh-notify-sound-complete', 'dsh-notify-sound-action'],
  )
  const errorSwitch = byType(tree, 'primitive-switch').find((element) => element.props.label === 'Turn failed')
  assert.equal(errorSwitch.props.checked, false)
})

test('settings page: silence is a tone choice, not a second way to disable', () => {
  const fixtures = setup()
  fixtures.settings.update({ soundAction: 'none' })
  const { tree } = render(fixtures)

  const action = byType(tree, 'primitive-switch').find((element) => element.props.label === 'Action needed')
  assert.equal(action.props.checked, true, 'the event stays on')

  const row = flatten(tree).find((element) => element.props?.className?.includes('dsh-notify-rowNested') &&
    byType(element, 'primitive-menu').some((menu) => menu.props.selectedId === 'none'))
  assert.ok(row, 'its tone row is still shown')
  assert.deepEqual(
    texts(row).filter((text) => text.startsWith('Silent')),
    ['Silent: kept on, but no tone plays.'],
    'and the row says what silence means',
  )
})

test('settings page: the master switch disables the whole page', () => {
  const fixtures = setup()
  fixtures.settings.update({ enabled: false })
  const { tree } = render(fixtures)

  const switches = byType(tree, 'primitive-switch')
  assert.equal(switches[0].props.disabled, undefined, 'the master switch stays operable')
  for (const element of switches.slice(1)) assert.equal(element.props.disabled, true)
  assert.equal(byType(tree, 'primitive-menu').length, 0, 'tone rows disappear with their events')
  assert.equal(byType(tree, 'input')[0].props.disabled, true, 'and the volume slider goes with them')
})

test('settings page: an undecided permission is an alert with one action', () => {
  const fixtures = setup('default')
  const { tree, calls } = render(fixtures)

  const alerts = flatten(tree).filter((element) => element.props?.role === 'alert')
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].props.className, 'dsh-notify-alert dsh-notify-alert-info')
  assert.deepEqual(
    texts(alerts[0]),
    ['Allow this site to show notifications from the Harness tab.', 'Allow notifications'],
  )
  assert.deepEqual(byType(alerts[0], 'primitive-info').length, 1)

  const action = byType(alerts[0], 'primitive-button')[0]
  assert.equal(action.props.variant, 'primary')
  assert.equal(calls.requestPermission, 0, 'asking takes a click, never a page open')
  action.props.onClick()
  assert.equal(calls.requestPermission, 1)
})

test('settings page: a granted permission leaves no standing row behind', () => {
  const fixtures = setup('granted')
  const { tree } = render(fixtures)

  assert.equal(flatten(tree).filter((element) => element.props?.role === 'alert').length, 0)
  assert.equal(flatten(tree).filter((element) => element.props?.['data-permission'] !== undefined).length, 0)
  assert.ok(!texts(tree).some((text) => /allowed for this site/i.test(text)), 'no permanent "all good" copy')
})

test('settings page: a blocked permission warns without an action it cannot perform', () => {
  const fixtures = setup('denied')
  const { tree } = render(fixtures)

  const alerts = flatten(tree).filter((element) => element.props?.role === 'alert')
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].props.className, 'dsh-notify-alert dsh-notify-alert-warn')
  assert.deepEqual(byType(alerts[0], 'primitive-warning').length, 1)
  assert.equal(byType(alerts[0], 'primitive-button').length, 0, 'only the browser settings can undo this')
  assert.deepEqual(texts(alerts[0]), [
    'Notifications are blocked for this site. Allow them in the browser site settings, then reload.',
  ])
})

test('settings page: an unsupported browser says so in the same alert', () => {
  const bundle = loadBundle({ storage: createStorage() })
  const internals = bundle.internals
  const t = (key) => internals.dictionaries.en[key] ?? key
  const settings = internals.createSettingsStore(bundle.window.localStorage)
  const permissionStore = internals.createPermissionStore({ globalObject: bundle.window })
  const tree = internals.NotificationsView({
    t,
    useSettings: (selector) => selector(settings.getSnapshot()),
    usePermission: (selector) => selector(permissionStore.getSnapshot()),
    setSetting: () => {},
    requestPermission: async () => 'unsupported',
    previewTone: () => ({ played: false, state: 'ready' }),
    sendTestNotification: () => ({ shown: false, sounded: false }),
  })

  const alerts = flatten(tree).filter((element) => element.props?.role === 'alert')
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].props.className, 'dsh-notify-alert dsh-notify-alert-warn')
  assert.deepEqual(texts(alerts[0]), ['This browser cannot show notifications. Sound alerts still work.'])
})

test('settings page: the volume slider is bounded, shared, and labelled', () => {
  const fixtures = setup()
  const { tree } = render(fixtures)
  const range = byType(tree, 'input')[0]
  assert.equal(range.props.type, 'range')
  assert.equal(range.props.min, 0)
  assert.equal(range.props.max, 100)
  assert.equal(range.props.value, 60)
  assert.equal(range.props['aria-label'], 'Volume')
  assert.deepEqual(texts(tree).filter((text) => text.endsWith('%')), ['60%'])
  assert.match(
    texts(tree).join(' '),
    /One level for every alert/,
    'the page says the three tones share it',
  )
})

test('settings page: the preview control is an icon button that auditions its own tone', () => {
  const fixtures = setup()
  const { tree, calls } = render(fixtures)

  const previews = byType(tree, 'button').filter((element) => element.props.className === 'dsh-notify-iconButton')
  assert.equal(previews.length, 3, 'one per outcome, next to its picker')
  for (const preview of previews) {
    assert.equal(preview.props['aria-label'], 'Preview sound', 'an icon still needs a spoken name')
    assert.equal(preview.props.title, 'Preview sound')
    assert.equal(preview.children.length, 1, 'no visible text label')
    assert.equal(flatten(preview.children)[0].type, 'primitive-play', 'the shipped play glyph')
  }

  previews[0].props.onClick()
  previews[1].props.onClick()
  previews[2].props.onClick()
  assert.deepEqual(calls.previewTone, ['chime', 'harp', 'droplet'], 'each button plays its own row')

  const test = byType(tree, 'primitive-button').find((element) => element.children.join('') === 'Send test notification')
  test.props.onClick()
  assert.equal(calls.sendTestNotification, 1)
})

test('settings page: a blocked audio context explains itself instead of failing silently', () => {
  const fixtures = setup()
  const { tree, setAudioState } = render(fixtures)
  assert.equal(
    flatten(tree).filter((element) => element.props?.role === 'status').length,
    0,
    'the first paint has nothing to report',
  )

  setAudioState('blocked')
  const notices = []
  /* Swap in a state hook whose setter records the key the page asked for, which
   * is the only way to observe an inline notice without a real renderer. */
  fixtures.bundle.react.useState = () => [null, (next) => notices.push(next)]
  const blocked = render(fixtures)
  blocked.setAudioState('blocked')
  byType(blocked.tree, 'button')
    .filter((element) => element.props.className === 'dsh-notify-iconButton')[0]
    .props.onClick()
  assert.deepEqual(notices, ['sound.blocked'], 'the page warns instead of silently doing nothing')
})

test('settings page: the blocked-audio warning renders as a status row', () => {
  const fixtures = setup()
  fixtures.bundle.react.useState = () => ['sound.blocked', () => {}]
  const { tree } = render(fixtures)

  const status = flatten(tree).filter((element) => element.props?.role === 'status')
  assert.equal(status.length, 1)
  assert.equal(status[0].type, 'p')
  assert.equal(status[0].props.className, 'dsh-notify-notice dsh-notify-noticeWarn')
  assert.deepEqual(
    status[0].children,
    ['The browser is holding back audio until you interact with the page. Click anywhere, then try again.'],
  )
})

test('settings page: a refused test notification reports through the same inline notice', () => {
  const fixtures = setup('default')
  fixtures.bundle.react.useState = () => ['notice.test.blocked', () => {}]
  const { tree } = render(fixtures)

  const status = flatten(tree).filter((element) => element.props?.role === 'status')
  assert.equal(status.length, 1)
  assert.deepEqual(
    status[0].children,
    ['Allow notifications first to see the test notification.'],
  )
})

test('settings page: the shipped Switch renders every toggle', () => {
  const fixtures = setup()
  const { tree, calls } = render(fixtures)

  const switches = byType(tree, 'primitive-switch')
  assert.deepEqual(
    switches.map((element) => element.props.label),
    [
      'Enable notifications',
      'Turn finished',
      'Action needed',
      'Turn failed',
      'Only while this page is in the background',
      'Include subagents',
    ],
  )
  assert.deepEqual(
    switches.map((element) => element.props.checked),
    [true, true, true, true, true, false],
  )
  switches[1].props.onChange(false)
  assert.deepEqual(calls.setSetting[0], ['notifyOnComplete', false])
})

test('settings page: the shipped Menu backs every tone picker', () => {
  const fixtures = setup()
  const { tree } = render(fixtures)

  assert.equal(byType(tree, 'select').length, 0, 'no hand-rolled select anywhere')
  const menus = byType(tree, 'primitive-menu')
  assert.equal(menus.length, 3)
  for (const menu of menus) {
    assert.equal(menu.props.align, 'end')
    assert.equal(menu.props.portal, true)
    assert.equal(menu.props.items.length, fixtures.internals.SOUND_IDS.length)
  }
  assert.deepEqual(
    menus.map((menu) => flatten(menu.props.anchor.children[1])[0].type),
    ['primitive-chevron', 'primitive-chevron', 'primitive-chevron'],
    'the shipped chevron glyph, not a home-made caret',
  )
})

test('settings page: the test notification is the shipped Button', () => {
  const fixtures = setup()
  const { tree, calls } = render(fixtures)

  const buttons = byType(tree, 'primitive-button')
  assert.deepEqual(buttons.map((element) => element.props.variant), ['primary'])
  assert.deepEqual(buttons.map((element) => element.props.size), ['md'])
  buttons[0].props.onClick()
  assert.equal(calls.sendTestNotification, 1)

  /* The alert's own action is a Button too, at the smaller shipped size. */
  const undecided = setup('default')
  const pending = render(undecided)
  const alertButton = byType(pending.tree, 'primitive-button')[0]
  assert.equal(alertButton.props.variant, 'primary')
  assert.equal(alertButton.props.size, 'sm')
})

test('settings page: the stylesheet never restyles a shipped control', () => {
  const fixtures = setup()
  const css = fixtures.internals.CSS
  assert.ok(!/\.dsh-notify-switch\b/.test(css), 'the toggle is the primitive, not a lookalike')
  assert.ok(!/\.dsh-notify-button\b/.test(css), 'the button is the primitive, not a lookalike')
  assert.ok(!/\.dsh-notify-select\b/.test(css), 'the picker is the primitive, not a lookalike')
})

test('settings page: rows sit inside titled, labelled groups', () => {
  const fixtures = setup()
  const { tree } = render(fixtures)

  const groups = flatten(tree).filter((element) => element.props?.role === 'group')
  assert.equal(groups.length, 3, 'events, scope, and the test action')

  const labelled = groups.map((element) => {
    const heading = byType(element, 'h3')[0]
    return {
      heading: heading.children.join(''),
      id: heading.props.id,
      labelledBy: element.props['aria-labelledby'],
      rows: flatten(element).filter((child) =>
        String(child.props?.className ?? '').split(' ').includes('dsh-notify-row'),
      ).length,
    }
  })
  assert.deepEqual(
    labelled.map((group) => group.heading),
    ['When to notify', 'Scope', 'Try it'],
  )
  for (const group of labelled) assert.equal(group.labelledBy, group.id, 'each group names itself from its heading')
  assert.deepEqual(
    labelled.map((group) => group.rows),
    [6, 3, 0],
    'three event rows + three tone rows, then two scope rows + the shared volume row',
  )

  const ids = labelled.map((group) => group.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('settings page: granting permission replaces the alert instead of adding a notice', () => {
  const fixtures = setup('default')
  const calls = []
  fixtures.requestPermissionResult = 'granted'

  const tree = fixtures.internals.NotificationsView({
    t: fixtures.t,
    useSettings: (selector) => selector(fixtures.settings.getSnapshot()),
    usePermission: (selector) => selector(fixtures.permissionStore.getSnapshot()),
    setSetting: () => {},
    requestPermission: async () => {
      /* The real store republishes; simulate the browser answering. */
      fixtures.Notification.setPermission('granted')
      fixtures.permissionStore.refresh()
      return 'granted'
    },
    previewTone: () => ({ played: true, state: 'ready' }),
    sendTestNotification: () => ({ shown: true, sounded: true }),
  })

  const alert = flatten(tree).find((element) => element.props?.role === 'alert')
  const action = byType(alert, 'primitive-button')[0]
  action.props.onClick()
  calls.push('clicked')
  assert.deepEqual(calls, ['clicked'])

  /* After the browser answers, the same page has nothing left to announce. */
  const after = fixtures.internals.NotificationsView({
    t: fixtures.t,
    useSettings: (selector) => selector(fixtures.settings.getSnapshot()),
    usePermission: (selector) => selector(fixtures.permissionStore.getSnapshot()),
    setSetting: () => {},
    requestPermission: async () => 'granted',
    previewTone: () => ({ played: true, state: 'ready' }),
    sendTestNotification: () => ({ shown: true, sounded: true }),
  })
  assert.equal(flatten(after).filter((element) => element.props?.role === 'alert').length, 0)
  assert.equal(flatten(after).filter((element) => element.props?.role === 'status').length, 0)
})

test('settings page: the stylesheet uses only host alias tokens for color', () => {
  const fixtures = setup()
  const css = fixtures.internals.CSS
  const colors = [...css.matchAll(/(?:color|background|border-color|accent-color)\s*:\s*([^;}]+)/g)].map((match) =>
    match[1].trim(),
  )
  assert.ok(colors.length > 5)
  for (const value of colors) {
    assert.ok(
      value.startsWith('var(--dsw-') || value === 'transparent' || value === 'inherit',
      `unexpected literal color "${value}"`,
    )
  }
  assert.ok(!/font-family:\s*[^;]*(Inter|Roboto|system-ui)/.test(css), 'inherits the host font')
  assert.match(css, /border-bottom:\.5px solid var\(--dsw-alias-border-l2\)/, 'shipped row hairline')
  assert.match(css, /font-size:16px;font-weight:500;line-height:24px/, 'shipped page title metrics')
  assert.match(css, /font-size:13px;font-weight:600;line-height:1\.5/, 'shipped group heading metrics')
})

test('settings page: the plugin registers itself exactly once per activation', () => {
  const Notification = createNotificationClass('granted')
  const bundle = loadBundle({ storage: createStorage(), Notification })
  const context = createClientContext()
  bundle.exports.apply(context.ctx)
  assert.equal(context.slotRegistrations.length, 1)
  assert.equal(context.injections.filter((key) => key === 'settings.section').length, 1)
  assert.equal(context.localeNamespaces.size, 1)
})
