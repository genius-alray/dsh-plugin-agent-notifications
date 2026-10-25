/**
 * Sandbox loader for `client.js`.
 *
 * The Client bundle is a browser artifact: it registers a lazy factory on
 * `window.__ModuleLoader__` and expects React plus browser globals. This
 * harness reproduces exactly that contract with plain objects, so the plugin's
 * logic can be exercised under `node --test` without a DOM.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'client.js')
const SOURCE = readFileSync(BUNDLE, 'utf8')

/**
 * Build one element record, flattening nested arrays the way React does.
 * @param type - tag name or component.
 * @param props - element props.
 * @param children - nested children.
 * @returns the element record.
 */
function createElement(type, props, ...children) {
  const flat = []
  const push = (value) => {
    if (value === null || value === undefined || value === false || value === true) return
    if (Array.isArray(value)) {
      for (const item of value) push(item)
      return
    }
    flat.push(value)
  }
  for (const child of children) push(child)
  return { type, props: props ?? {}, children: flat }
}

/** Minimal React surface the bundle uses. */
export function createReactStub() {
  const states = []
  return {
    createElement,
    useState(initial) {
      states.push(initial)
      const index = states.length - 1
      return [initial, (next) => {
        states[index] = typeof next === 'function' ? next(states[index]) : next
      }]
    },
    useEffect() {},
    useRef(value) {
      return { current: value }
    },
    useMemo(factory) {
      return factory()
    },
    useCallback(callback) {
      return callback
    },
  }
}

/**
 * Collect every element in a rendered tree, rendering function components the
 * way React would so a test can assert what a borrowed primitive received.
 * @param node - element, array, or primitive.
 * @param out - accumulator.
 * @returns the accumulator.
 */
export function flatten(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out)
    return out
  }
  if (typeof node.type === 'object' && node.type !== null && typeof node.type.render === 'function') {
    /* A `forwardRef`/`memo` component object: invoke its render function so a
     * test asserts the props the shipped library actually receives. */
    const props = { ...node.props }
    if (node.children.length > 0) props.children = node.children.length === 1 ? node.children[0] : node.children
    flatten(node.type.render(props), out)
    return out
  }
  if (typeof node.type === 'function') {
    /* React's `createElement(type, props, ...children)` and a props object that
     * already carries `children` are both legal; only override the latter when
     * the call site actually passed children. */
    const props = { ...node.props }
    if (node.children.length > 0) props.children = node.children.length === 1 ? node.children[0] : node.children
    flatten(node.type(props), out)
    return out
  }
  out.push(node)
  for (const child of node.children ?? []) flatten(child, out)
  return out
}

/**
 * Read every element of one tag from a rendered tree.
 * @param tree - element tree.
 * @param type - tag name to match.
 * @returns matching elements.
 */
export function byType(tree, type) {
  return flatten(tree).filter((element) => element.type === type)
}

/**
 * Build a fake `localStorage`.
 * @param seed - initial entries.
 * @returns the storage, with an optional failure switch.
 */
export function createStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    failWrites: false,
    getItem(key) {
      return map.has(key) ? map.get(key) : null
    },
    setItem(key, value) {
      if (this.failWrites) throw new Error('storage denied')
      map.set(key, String(value))
    },
    removeItem(key) {
      map.delete(key)
    },
    dump() {
      return Object.fromEntries(map)
    },
  }
}

/**
 * Load the bundle and materialize its factory.
 * @param option - browser globals to install.
 * @returns the bundle exports and the sandbox's captured registration.
 */
export function loadBundle(option = {}) {
  const registrations = []
  const listeners = new Map()
  const appendedStyles = []

  const documentStub = {
    visibilityState: option.visibilityState ?? 'visible',
    hasFocus: typeof option.hasFocus === 'function' ? option.hasFocus : undefined,
    head: {
      appendChild(node) {
        appendedStyles.push(node)
        return node
      },
    },
    createElement(tag) {
      return {
        tagName: tag,
        dataset: {},
        textContent: '',
        remove() {
          const index = appendedStyles.indexOf(this)
          if (index >= 0) appendedStyles.splice(index, 1)
        },
      }
    },
    addEventListener() {},
    removeEventListener() {},
  }

  const windowStub = {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration)
      },
    },
    localStorage: option.storage,
    Notification: option.Notification,
    AudioContext: option.AudioContext,
    location: {},
    focus() {},
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
  }

  /* The bundle body runs in the host realm through a plain function wrapper:
   * that keeps arrays, maps, and errors instanceof-comparable in assertions
   * while still giving the artifact exactly the two browser globals it reads. */
  const run = new Function('window', 'document', SOURCE)
  run(windowStub, documentStub)

  const registration = registrations[0]
  if (registration === undefined) throw new Error('the bundle did not register a module factory')

  const react = createReactStub()
  const requireStub = (id) => {
    if (id === 'react') return react
    if (id === 'react/jsx-runtime') return { jsx: createElement, jsxs: createElement }
    /* The Web platform always ships the primitive library as a seed module, so
     * the bundle requires it unconditionally. */
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return option.primitives ?? createPrimitives()
    throw new Error(`unexpected require("${id}") in the client bundle`)
  }

  const exports = registration.factory(requireStub)
  return {
    id: registration.id,
    exports,
    internals: exports.__internals,
    react,
    window: windowStub,
    document: documentStub,
    styles: appendedStyles,
    fire(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event)
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0
    },
  }
}

/**
 * Build the Harness primitive library stand-in. The shipped module mixes plain
 * function components (`Switch`, `Menu`, the icons) with a `forwardRef` one
 * (`Button`), and this stub keeps that shape so a test notices if the bundle
 * ever stops accepting a component object.
 * @returns the primitives module.
 */
export function createPrimitives() {
  function Switch(props) {
    return { type: 'primitive-switch', props, children: [] }
  }
  function Menu(props) {
    return { type: 'primitive-menu', props, children: [] }
  }
  function buttonIcon(type) {
    return function Icon(props) {
      return { type, props, children: [] }
    }
  }
  return {
    Switch,
    Menu,
    Button: {
      $$typeof: Symbol.for('react.forward_ref'),
      render(props) {
        return { type: 'primitive-button', props, children: props.children === undefined ? [] : [props.children] }
      },
    },
    IconChevronDownOutlineRegular: buttonIcon('primitive-chevron'),
    IconPlayOutlineRegular: buttonIcon('primitive-play'),
    IconInfoOutlineRegular: buttonIcon('primitive-info'),
    IconWarningOutlineRegular: buttonIcon('primitive-warning'),
  }
}

/**
 * Build a Notification class whose instances are observable.
 * @param permission - the browser's permission answer.
 * @returns the constructor plus the created instances.
 */
export function createNotificationClass(permission = 'granted') {
  const created = []
  class FakeNotification {
    static permission = permission
    static async requestPermission() {
      return permission
    }
    constructor(title, options) {
      this.title = title
      this.options = options ?? {}
      this.onclick = undefined
      created.push(this)
    }
    close() {}
  }
  FakeNotification.created = created
  FakeNotification.setPermission = (next) => {
    FakeNotification.permission = next
  }
  return FakeNotification
}

/**
 * Build an AudioContext stub recording scheduled oscillators.
 * @param option - initial state and behavior.
 * @returns the constructor plus the created contexts.
 */
export function createAudioContextClass(option = {}) {
  const contexts = []
  class FakeAudioContext {
    constructor() {
      this.state = option.state ?? 'running'
      this.currentTime = option.currentTime ?? 0
      this.destination = { kind: 'destination' }
      this.started = []
      this.envelopes = []
      this.resumed = 0
      this.closed = 0
      if (option.throwOnCreate === true) throw new Error('audio unavailable')
      contexts.push(this)
    }
    createOscillator() {
      const context = this
      const oscillator = {
        type: 'sine',
        frequency: { value: 0 },
        connected: false,
        start(at) {
          oscillator.startedAt = at
        },
        stop(at) {
          oscillator.stoppedAt = at
          context.started.push({
            type: oscillator.type,
            freq: oscillator.frequency.value,
            at: oscillator.startedAt,
            until: at,
            gain: oscillator.gain,
          })
        },
        connect(gain) {
          oscillator.gain = gain
        },
      }
      return oscillator
    }
    createGain() {
      const context = this
      const envelope = []
      const node = {
        gain: {
          value: 0,
          setValueAtTime(level, at) {
            envelope.push(['set', level, at])
          },
          linearRampToValueAtTime(level, at) {
            envelope.push(['linear', level, at])
          },
          exponentialRampToValueAtTime(level, at) {
            envelope.push(['exponential', level, at])
          },
        },
        envelope,
        connect(destination) {
          this.destination = destination
          context.envelopes.push(envelope)
        },
      }
      return node
    }
    async resume() {
      this.resumed += 1
      this.state = 'running'
    }
    close() {
      this.closed += 1
      this.state = 'closed'
    }
  }
  FakeAudioContext.contexts = contexts
  return FakeAudioContext
}

/**
 * Build a fake Client Cordis context recording every registration.
 * @param option - wiring overrides.
 * @returns the context plus its recorded state.
 */
export function createClientContext(option = {}) {
  const effects = []
  const slotRegistrations = []
  const injections = []
  const remoteListeners = []
  const disposals = []
  const localeNamespaces = new Map()
  const statusListeners = new Set()

  const statusSource = {
    getSnapshot: () => option.statusSnapshot ?? new Map(),
    subscribe(listener) {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
  }

  const sessions = option.sessions ?? {
    list: {
      getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
    },
  }

  const ctx = {
    effect(callback) {
      const dispose = callback()
      effects.push(dispose)
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    locale: {
      register(ns, dicts) {
        localeNamespaces.set(ns, dicts)
        return () => localeNamespaces.delete(ns)
      },
      bind(ns) {
        return (key, params) => {
          const dicts = localeNamespaces.get(ns) ?? {}
          const dictionary = dicts.en ?? {}
          const template = dictionary[key] ?? key
          if (params === undefined) return template
          return template.replace(/\{(\w+)\}/g, (match, name) =>
            Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
          )
        }
      },
    },
    slots: {
      inject(key, callback) {
        injections.push(key)
        const dispose = callback()
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      },
      register(options, component) {
        slotRegistrations.push({ options, component })
        return () => {
          const index = slotRegistrations.findIndex((entry) => entry.options === options)
          if (index >= 0) slotRegistrations.splice(index, 1)
        }
      },
    },
    sessions,
    uiSession: { sessionStatus: statusSource },
    remote: {
      $on(event, listener) {
        remoteListeners.push({ event, listener })
        return () => {
          const index = remoteListeners.findIndex((entry) => entry.listener === listener)
          if (index >= 0) remoteListeners.splice(index, 1)
        }
      },
    },
    get(name) {
      return option.services?.[name]
    },
  }

  return {
    ctx,
    effects,
    slotRegistrations,
    injections,
    remoteListeners,
    localeNamespaces,
    /** Publish a new status snapshot to every subscriber. */
    setStatus(snapshot) {
      option.statusSnapshot = snapshot
      for (const listener of statusListeners) listener()
    },
    /** Deliver one forwarded session-error event. */
    emitError(sessionId, message) {
      for (const listener of remoteListeners) {
        if (listener.event === 'api-session/error') listener.listener(sessionId, message)
      }
    },
    /** Run every recorded effect disposer, newest first. */
    disposeAll() {
      for (const dispose of [...effects].reverse()) {
        if (typeof dispose === 'function') dispose()
      }
      disposals.push(true)
    },
    statusListenerCount: () => statusListeners.size,
  }
}
