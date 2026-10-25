/**
 * Client half of the agent-notification bundle.
 *
 * The page owns the browser Notification permission, so every decision lives
 * here: this module watches the Session UI status the Session plugin already
 * derives (running ⇄ idle plus the pending interaction currently awaiting the
 * user), watches the forwarded session-error events, and raises one
 * `Notification` per interesting transition plus an optional synthesized alert
 * tone through the Web Audio API.
 *
 * Preferences are per-browser and stored in `localStorage`, next to the
 * permission they depend on, instead of the Host profile document.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-agent-notifications',
  factory(require) {
    const React = require('react')
    /* The Web platform always ships the Harness primitive library as a seed
     * module of the boot graph, so its controls are used directly: this page must
     * look and behave like every other Settings page, not like a lookalike. */
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const {
      Button,
      IconChevronDownOutlineRegular,
      IconInfoOutlineRegular,
      IconPlayOutlineRegular,
      IconWarningOutlineRegular,
      Menu,
      Switch,
    } = primitives

    /** Locale namespace owned by this plugin. */
    const NS = 'agentNotifications'
    /** Storage key of the per-browser preferences document. */
    const STORAGE_KEY = 'dsh.agent-notifications.v1'
    /** Window in which the same session+kind is only announced once. */
    const DEDUPE_MS = 4000
    /** Window in which a failure also silences that Session's completion alert. */
    const FAILURE_QUIET_MS = 3000
    /** Interaction kinds whose appearance means "the user must act". */
    const ACTION_KINDS = ['approval', 'question', 'plan-review']

    /** Notification kinds this plugin raises; `suppressed` dispatches on them. */
    const EVENT_KINDS = Object.freeze(['complete', 'action', 'error'])
    /** Alert tones offered in Settings; `none` disables that alert's sound. */
    const SOUND_IDS = ['none', 'soft', 'chime', 'marimba', 'harp', 'droplet']
    /** Preference field that carries the tone of each alert kind. */
    const SOUND_FIELDS = Object.freeze({ complete: 'soundComplete', action: 'soundAction', error: 'soundError' })

    /**
     * Synthesized tone tables: one entry per struck note. Every voice is a sine
     * with a short attack and a long exponential decay, plus quiet octave and
     * twelfth partials, because a bare square or triangle wave with an instant
     * start is exactly what makes a browser alert sound like a machine beeping.
     */
    const TONES = Object.freeze({
      soft: Object.freeze([
        { freq: 440, at: 0, dur: 0.85, gain: 0.8, attack: 0.014, harmonics: [{ ratio: 2, gain: 0.1 }] },
      ]),
      chime: Object.freeze([
        { freq: 659.25, at: 0, dur: 0.95, gain: 0.85, attack: 0.01, harmonics: [{ ratio: 2, gain: 0.14 }, { ratio: 3, gain: 0.04 }] },
        { freq: 880, at: 0.17, dur: 0.95, gain: 0.7, attack: 0.014, harmonics: [{ ratio: 2, gain: 0.12 }] },
      ]),
      marimba: Object.freeze([
        { freq: 587.33, at: 0, dur: 0.5, gain: 0.8, attack: 0.008, harmonics: [{ ratio: 3, gain: 0.14 }] },
        { freq: 739.99, at: 0.11, dur: 0.6, gain: 0.7, attack: 0.01, harmonics: [{ ratio: 3, gain: 0.12 }] },
      ]),
      harp: Object.freeze([
        { freq: 440, at: 0, dur: 0.7, gain: 0.65, attack: 0.008, harmonics: [{ ratio: 2, gain: 0.12 }] },
        { freq: 554.37, at: 0.08, dur: 0.7, gain: 0.6, attack: 0.008, harmonics: [{ ratio: 2, gain: 0.11 }] },
        { freq: 659.25, at: 0.16, dur: 0.8, gain: 0.55, attack: 0.01, harmonics: [{ ratio: 2, gain: 0.1 }] },
      ]),
      /* Two notes stepping down: reads as "something went wrong" without the
       * harshness of a buzzer, and stays in the same struck-string family. */
      droplet: Object.freeze([
        { freq: 493.88, at: 0, dur: 0.9, gain: 0.75, attack: 0.012, harmonics: [{ ratio: 2, gain: 0.1 }] },
        { freq: 329.63, at: 0.15, dur: 1.15, gain: 0.7, attack: 0.016, harmonics: [{ ratio: 2, gain: 0.08 }] },
      ]),
    })

    /**
     * Default preferences for a browser that never saved any. Each alert kind
     * starts on a different tone, so the three outcomes are distinguishable by
     * ear alone; the volume is shared.
     */
    const DEFAULTS = Object.freeze({
      enabled: true,
      notifyOnComplete: true,
      notifyOnAction: true,
      notifyOnError: true,
      onlyWhenHidden: true,
      includeSubagents: false,
      soundComplete: 'chime',
      soundAction: 'harp',
      soundError: 'droplet',
      volume: 60,
    })

    /** English copy; key set is the source of truth for the Chinese dictionary. */
    const en = Object.freeze({
      nav: 'Notifications',
      'page.title': 'Notifications',
      'page.intro':
        'Send a browser notification when an agent needs you. Notifications come from this page, so keep the Harness tab open.',
      'page.footnote': 'Clicking a notification focuses this window and opens that session.',
      'master.title': 'Enable notifications',
      'master.description': 'Turn every browser notification from this plugin on or off.',
      'permission.default': 'Allow this site to show notifications from the Harness tab.',
      'permission.denied': 'Notifications are blocked for this site. Allow them in the browser site settings, then reload.',
      'permission.unsupported': 'This browser cannot show notifications. Sound alerts still work.',
      'permission.request': 'Allow notifications',
      'events.heading': 'When to notify',
      'events.complete.title': 'Turn finished',
      'events.complete.description': 'The agent stopped working on a session.',
      'events.action.title': 'Action needed',
      'events.action.description': 'An approval, question, or plan review is waiting for you.',
      'events.error.title': 'Turn failed',
      'events.error.description': 'The session stopped with an error.',
      'behavior.heading': 'Scope',
      'onlyWhenHidden.title': 'Only while this page is in the background',
      'onlyWhenHidden.description':
        'A hidden tab or an unfocused window both count as background; an attended Harness window is skipped.',
      'includeSubagents.title': 'Include subagents',
      'includeSubagents.description': 'Also notify for delegated child sessions.',
      'sound.preset.label': 'Sound',
      'sound.preset.hint': 'Plays when this happens.',
      'sound.silent.hint': 'Silent: kept on, but no tone plays.',
      'sound.preset.none': 'None',
      'sound.preset.soft': 'Soft',
      'sound.preset.chime': 'Chime',
      'sound.preset.marimba': 'Marimba',
      'sound.preset.harp': 'Harp arpeggio',
      'sound.preset.droplet': 'Droplet',
      'sound.volume.label': 'Volume',
      'sound.volume.value': '{value}%',
      'sound.volume.description': 'One level for every alert.',
      'sound.preview': 'Preview sound',
      'sound.blocked': 'The browser is holding back audio until you interact with the page. Click anywhere, then try again.',
      'sound.test': 'Send test notification',
      'test.heading': 'Try it',
      'notice.test.shown': 'Test notification sent.',
      'notice.test.blocked': 'Allow notifications first to see the test notification.',
      'title.complete': '{session} finished',
      'title.action': '{session} needs you',
      'title.error': '{session} failed',
      'title.test': 'Test notification',
      'body.complete': 'The agent finished this turn.',
      'body.error': '{message}',
      'body.action.approval': '{tool} is waiting for your approval.',
      'body.action.question': '{question}',
      'body.action.planReview': 'A plan is waiting for your review.',
      'body.test': 'Notifications from DeepSeek Harness are working.',
    })

    /** Simplified Chinese copy, keyed exactly like {@link en}. */
    const zh = Object.freeze({
      nav: '通知',
      'page.title': '通知',
      'page.intro': '任务需要你时发送浏览器通知。通知由当前页面发出，请保持 Harness 标签页打开。',
      'page.footnote': '点击通知会聚焦本窗口并打开对应会话。',
      'master.title': '启用通知',
      'master.description': '一次性开关本插件发出的所有浏览器通知。',
      'permission.default': '允许本站从 Harness 标签页发送通知。',
      'permission.denied': '本站的通知已被阻止。请在浏览器站点设置中允许通知后重新加载。',
      'permission.unsupported': '当前浏览器不支持通知，仍会播放提示音。',
      'permission.request': '允许通知',
      'events.heading': '触发时机',
      'events.complete.title': '任务完成',
      'events.complete.description': '会话中的 Agent 停止了本轮工作。',
      'events.action.title': '需要操作',
      'events.action.description': '有审批、提问或计划审阅正在等待你。',
      'events.error.title': '任务出错',
      'events.error.description': '会话因错误停止。',
      'behavior.heading': '范围',
      'onlyWhenHidden.title': '仅在页面处于后台时提醒',
      'onlyWhenHidden.description': '标签页隐藏或窗口未聚焦都算后台；Harness 窗口在前台时跳过。',
      'includeSubagents.title': '包含子代理',
      'includeSubagents.description': '被委派的子会话也发送通知。',
      'sound.preset.label': '提示音',
      'sound.preset.hint': '发生这种情况时播放。',
      'sound.silent.hint': '静音：开关保持开启，但不播放声音。',
      'sound.preset.none': '静音',
      'sound.preset.soft': '轻提示',
      'sound.preset.chime': '叮咚',
      'sound.preset.marimba': '木琴',
      'sound.preset.harp': '竖琴琶音',
      'sound.preset.droplet': '水滴',
      'sound.volume.label': '音量',
      'sound.volume.value': '{value}%',
      'sound.volume.description': '所有提示音共用一个音量。',
      'sound.preview': '试听提示音',
      'sound.blocked': '浏览器正在等待你与页面交互后才允许播放声音。先在页面上点一下，再试听。',
      'sound.test': '发送测试通知',
      'test.heading': '试一下',
      'notice.test.shown': '测试通知已发送。',
      'notice.test.blocked': '请先允许通知，才能看到测试通知。',
      'title.complete': '{session} 已完成',
      'title.action': '{session} 需要你的操作',
      'title.error': '{session} 出错了',
      'title.test': '测试通知',
      'body.complete': 'Agent 已完成本轮工作。',
      'body.error': '{message}',
      'body.action.approval': '{tool} 正在等待你的审批。',
      'body.action.question': '{question}',
      'body.action.planReview': '有一份计划正在等待你审阅。',
      'body.test': 'DeepSeek Harness 的通知可以正常显示。',
    })

    /** Client services this plugin cannot work without. */
    const inject = ['locale', 'slots', 'sessions', 'uiSession', 'remote']

    // --------------------------------------------------------------------- //
    // Small pure helpers
    // --------------------------------------------------------------------- //

    /**
     * Clamp an unknown value into the supported volume range.
     * @param value - candidate volume.
     * @returns an integer between 0 and 100.
     */
    function clampVolume(value) {
      const number = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(number)) return DEFAULTS.volume
      return Math.max(0, Math.min(100, Math.round(number)))
    }

    /**
     * Collapse whitespace so a notification body stays a single line.
     * @param value - raw text.
     * @returns the collapsed text.
     */
    function oneLine(value) {
      return String(value === undefined || value === null ? '' : value)
        .replace(/\s+/g, ' ')
        .trim()
    }

    /**
     * Cut text at a code-point boundary with an ellipsis.
     * @param value - source text.
     * @param limit - maximum code points kept.
     * @returns the shortened text.
     */
    function truncate(value, limit) {
      const text = String(value === undefined || value === null ? '' : value)
      const points = Array.from(text)
      if (points.length <= limit) return text
      return `${points.slice(0, Math.max(0, limit - 1)).join('')}…`
    }

    /**
     * Read a boolean preference, keeping the default for any other type.
     * @param value - raw preference.
     * @param fallback - value used when the input is not a boolean.
     * @returns the resolved boolean.
     */
    function asBoolean(value, fallback) {
      return typeof value === 'boolean' ? value : fallback
    }

    /**
     * Normalize a stored or partially patched preference document.
     * @param raw - untrusted value read from storage or built from a patch.
     * @returns a complete, validated preference document.
     */
    /**
     * Read one tone preference, keeping that kind's default for anything else.
     * @param value - raw preference.
     * @param fallback - the default tone of this alert kind.
     * @returns a supported tone id.
     */
    function asTone(value, fallback) {
      return SOUND_IDS.includes(value) ? value : fallback
    }

    function normalizeSettings(raw) {
      const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
      return {
        enabled: asBoolean(source.enabled, DEFAULTS.enabled),
        notifyOnComplete: asBoolean(source.notifyOnComplete, DEFAULTS.notifyOnComplete),
        notifyOnAction: asBoolean(source.notifyOnAction, DEFAULTS.notifyOnAction),
        notifyOnError: asBoolean(source.notifyOnError, DEFAULTS.notifyOnError),
        onlyWhenHidden: asBoolean(source.onlyWhenHidden, DEFAULTS.onlyWhenHidden),
        includeSubagents: asBoolean(source.includeSubagents, DEFAULTS.includeSubagents),
        soundComplete: asTone(source.soundComplete, DEFAULTS.soundComplete),
        soundAction: asTone(source.soundAction, DEFAULTS.soundAction),
        soundError: asTone(source.soundError, DEFAULTS.soundError),
        volume: clampVolume(source.volume === undefined ? DEFAULTS.volume : source.volume),
      }
    }

    /**
     * Compare two normalized preference documents field by field.
     * @param left - first document.
     * @param right - second document.
     * @returns whether every supported field agrees.
     */
    function sameSettings(left, right) {
      return Object.keys(DEFAULTS).every((field) => left[field] === right[field])
    }

    /**
     * Wrap a storage implementation with the JSON preference document.
     * @param storage - `localStorage`-compatible object, or undefined.
     * @returns an object whose reads never throw.
     */
    function preferenceDocument(storage) {
      return {
        read() {
          if (storage === undefined) return { ...DEFAULTS }
          let raw
          try {
            raw = storage.getItem(STORAGE_KEY)
          } catch (error) {
            return { ...DEFAULTS }
          }
          if (typeof raw !== 'string' || raw === '') return { ...DEFAULTS }
          try {
            return normalizeSettings(JSON.parse(raw))
          } catch (error) {
            return { ...DEFAULTS }
          }
        },
        write(settings) {
          if (storage === undefined) return false
          try {
            storage.setItem(STORAGE_KEY, JSON.stringify(settings))
            return true
          } catch (error) {
            return false
          }
        },
      }
    }

    /**
     * Create the observable preference store a Slot hook can read.
     * @param storage - `localStorage`-compatible object, or undefined for memory only.
     * @returns the preference store.
     */
    function createSettingsStore(storage) {
      const document = preferenceDocument(storage)
      let current = document.read()
      const listeners = new Set()
      return {
        getSnapshot: () => current,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        /**
         * Merge one patch into the document and publish when anything changed.
         * @param patch - partial preference document.
         * @returns the current document.
         */
        update(patch) {
          const next = normalizeSettings({ ...current, ...(patch !== null && typeof patch === 'object' ? patch : {}) })
          if (sameSettings(next, current)) return current
          current = next
          document.write(next)
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch (error) {
              console.error('[agent-notifications] preference listener failed:', error)
            }
          }
          return current
        },
      }
    }

    // --------------------------------------------------------------------- //
    // Browser permission
    // --------------------------------------------------------------------- //

    /**
     * Normalize a Notification permission string.
     * @param value - raw permission.
     * @returns one of `granted`, `denied`, `default`.
     */
    function normalizePermission(value) {
      return value === 'granted' || value === 'denied' ? value : 'default'
    }

    /**
     * Observe and request the browser Notification permission.
     * @param option - `{ globalObject }` carrying `Notification` when available.
     * @returns the permission store.
     */
    function createPermissionStore(option = {}) {
      const globalObject = option.globalObject
      const Ctor = globalObject && typeof globalObject.Notification === 'function' ? globalObject.Notification : undefined
      const compute = () => {
        if (Ctor === undefined) return { supported: false, permission: 'unsupported' }
        return { supported: true, permission: normalizePermission(Ctor.permission) }
      }
      let current = compute()
      const listeners = new Set()
      const publish = () => {
        const next = compute()
        if (next.supported === current.supported && next.permission === current.permission) return
        current = next
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.error('[agent-notifications] permission listener failed:', error)
          }
        }
      }
      return {
        getSnapshot: () => current,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        /** Re-read the browser permission after an out-of-band change. */
        refresh: publish,
        /**
         * Ask the browser for permission. Must run inside a user gesture.
         * @returns the resulting permission string.
         */
        async request() {
          if (Ctor === undefined) return 'unsupported'
          if (typeof Ctor.requestPermission !== 'function') {
            publish()
            return current.permission
          }
          let result
          try {
            result = await Ctor.requestPermission()
          } catch (error) {
            publish()
            return current.permission
          }
          publish()
          return typeof result === 'string' ? normalizePermission(result) : current.permission
        },
        /**
         * Construct a notification with this browser's own class.
         * @param title - notification title.
         * @param options - notification options.
         * @returns the handle, or undefined when unsupported or refused.
         */
        construct(title, options) {
          if (Ctor === undefined) return undefined
          try {
            return new Ctor(title, options)
          } catch (error) {
            return undefined
          }
        },
      }
    }

    // --------------------------------------------------------------------- //
    // Alert tone player
    // --------------------------------------------------------------------- //

    /**
     * Create the Web Audio alert player. Every failure is silent: a page that
     * never received a user gesture simply gets no tone, never an exception.
     * @param option - contexts, tone tables, and master gain.
     * @returns the player.
     */
    function createSoundPlayer(option = {}) {
      const createContext = typeof option.createContext === 'function' ? option.createContext : () => undefined
      const tones = option.tones === undefined ? TONES : option.tones
      const baseGain = typeof option.baseGain === 'number' ? option.baseGain : 0.22
      let context
      let unusable = false
      /* Set only when `resume()` actually rejects. Treating "not running yet"
       * as blocked would flash a warning on every preview: `resume()` resolves
       * asynchronously, so the state read immediately after a click is still
       * `suspended` even though audio is about to work. */
      let blocked = false
      const acquire = () => {
        if (context !== undefined || unusable) return context
        let created
        try {
          created = createContext()
        } catch (error) {
          unusable = true
          return undefined
        }
        if (
          created === undefined ||
          created === null ||
          typeof created.createOscillator !== 'function' ||
          typeof created.createGain !== 'function'
        ) {
          unusable = true
          return undefined
        }
        context = created
        return context
      }
      const resume = (audio) => {
        if (audio.state === 'running') {
          blocked = false
          return
        }
        if (typeof audio.resume !== 'function') {
          blocked = true
          return
        }
        try {
          const attempt = audio.resume()
          if (attempt === undefined || typeof attempt.then !== 'function') return
          attempt.then(
            () => {
              blocked = false
            },
            () => {
              blocked = true
            },
          )
        } catch (error) {
          blocked = true
        }
      }
      /**
       * Schedule one preset's notes on a running context.
       * @param tone - note table of the preset.
       * @param level - normalized volume.
       * @param audio - the audio context.
       * @returns whether any note was scheduled.
       */
      const schedule = (tone, level, audio) => {
        try {
          const origin = typeof audio.currentTime === 'number' ? audio.currentTime : 0
          for (const note of tone) {
            const start = origin + (note.at === undefined ? 0 : note.at)
            const duration = note.dur === undefined ? 0.6 : note.dur
            const attack = Math.min(note.attack === undefined ? 0.01 : note.attack, duration / 2)
            const peak = level * baseGain * (note.gain === undefined ? 1 : note.gain)
            const voices = [{ ratio: 1, gain: 1 }].concat(note.harmonics === undefined ? [] : note.harmonics)
            for (const voice of voices) {
              const oscillator = audio.createOscillator()
              const gain = audio.createGain()
              oscillator.type = 'sine'
              oscillator.frequency.value = note.freq * voice.ratio
              const voicePeak = peak * (voice.gain === undefined ? 1 : voice.gain)
              /* A struck string, not a switch: ramp up over a few milliseconds
               * and fall away exponentially, which removes the click a hard
               * start produces and keeps the tail gentle instead of abrupt. */
              gain.gain.setValueAtTime(0, start)
              gain.gain.linearRampToValueAtTime(voicePeak, start + attack)
              gain.gain.exponentialRampToValueAtTime(Math.max(voicePeak * 0.0001, 1e-5), start + duration)
              oscillator.connect(gain)
              gain.connect(audio.destination)
              oscillator.start(start)
              oscillator.stop(start + duration + 0.02)
            }
          }
          return true
        } catch (error) {
          return false
        }
      }

      return {
        /**
         * Attempt to create and resume the audio context inside a gesture.
         * @returns whether the context exists and can play.
         */
        unlock() {
          const audio = acquire()
          if (audio === undefined) return false
          resume(audio)
          return audio.state === 'running'
        },
        /**
         * Resume the context without scheduling anything. Used on focus and
         * visibility changes: Chrome re-suspends an idle context, and a resumed
         * context makes the next alert audible without a fresh gesture.
         * @returns the resulting {@link state}.
         */
        wake() {
          const audio = acquire()
          if (audio === undefined) return 'unsupported'
          resume(audio)
          if (audio.state === 'running') return 'ready'
          return blocked ? 'blocked' : 'pending'
        },
        /**
         * Report whether a tone can be heard right now.
         * @returns `ready` when the context runs, `blocked` once the browser has
         * refused to resume it, `pending` while a resume is still in flight (a
         * gesture normally resolves it, so that is not an error worth warning
         * about), and `unsupported` when there is no Web Audio at all.
         */
        state() {
          const audio = acquire()
          if (audio === undefined) return 'unsupported'
          if (audio.state === 'running') return 'ready'
          return blocked ? 'blocked' : 'pending'
        },
        /**
         * Play one preset at one volume.
         * @param presetId - preset identifier; `none` and unknown ids stay silent.
         * @param volume - 0-100 volume.
         * @returns whether any tone was scheduled.
         */
        play(presetId, volume) {
          const tone = Object.prototype.hasOwnProperty.call(tones, presetId) ? tones[presetId] : undefined
          if (tone === undefined || tone.length === 0) return false
          const level = clampVolume(volume) / 100
          if (level <= 0) return false
          const audio = acquire()
          if (audio === undefined) return false

          /* Schedule first, resume second. Notes are queued at the context's own
           * `currentTime`, which does not advance while the context is
           * suspended, so anything queued before `resume()` resolves still plays
           * the moment the browser lets audio through. Awaiting the resume before
           * scheduling is what silently drops the first alert after a tab sits
           * idle long enough for Chrome to suspend the context again. */
          const scheduled = schedule(tone, level, audio)
          resume(audio)
          return scheduled
        },
        /** Release the audio context. */
        dispose() {
          const audio = context
          context = undefined
          if (audio === undefined) return
          try {
            if (typeof audio.close === 'function') audio.close()
          } catch (error) {
            /* A closed context has nothing left to release. */
          }
        },
      }
    }

    // --------------------------------------------------------------------- //
    // Dispatcher: notification + tone transport
    // --------------------------------------------------------------------- //

    /**
     * Create the transport that turns one semantic alert into a browser
     * notification and/or an alert tone.
     * @param dependency - permission and delivery functions plus copy.
     * @returns the dispatcher.
     */
    function createDispatcher(dependency) {
      const { permission, notify, play, focus, openSession } = dependency
      return {
        /**
         * Deliver one alert. The tone plays even when notifications are refused,
         * so a page without permission still draws attention.
         * @param request - composed alert.
         * @returns what actually happened.
         */
        deliver(request) {
          let shown = false
          if (permission() === 'granted') {
            const handle = notify(request.title, {
              body: request.body,
              tag: request.tag,
              silent: true,
              renotify: true,
            })
            if (handle !== undefined && handle !== null) {
              shown = true
              try {
                handle.onclick = () => {
                  focus()
                  openSession(request.sessionId)
                }
              } catch (error) {
                /* A frozen handle still displays; only the click action is lost. */
              }
            }
          }
          const sounded = play(request.sound, request.volume) === true
          return { shown, sounded }
        },
      }
    }

    // --------------------------------------------------------------------- //
    // Engine: session status → alerts
    // --------------------------------------------------------------------- //

    /**
     * Create the state machine that turns Session UI status transitions into
     * alerts. The first sighting of a session is a baseline and never alerts.
     * @param dependency - preferences, environment probes, and delivery.
     * @returns the engine.
     */
    function createEngine(dependency) {
      const { store, environment } = dependency
      /** Last observed status per Session. */
      const seen = new Map()
      /** Suppression window per `kind:sessionId`. */
      const recent = new Map()
      /** Last reported failure per Session, used to fold completion into the error. */
      const failedAt = new Map()

      const settings = () => store.getSnapshot()

      /**
       * Decide whether this alert is wanted right now.
       * @param kind - alert kind.
       * @param sessionId - owning Session.
       * @param subagent - whether the Session is a delegated child.
       * @param request - identity of the concrete request, for action alerts.
       * @returns whether the alert must be dropped.
       */
      const suppressed = (kind, sessionId, subagent, request) => {
        if (!EVENT_KINDS.includes(kind)) return true
        const current = settings()
        if (!current.enabled) return true
        if (kind === 'complete' && !current.notifyOnComplete) return true
        if (kind === 'action' && !current.notifyOnAction) return true
        if (kind === 'error' && !current.notifyOnError) return true
        if (current.onlyWhenHidden && !environment.isHidden()) return true
        /* An approval or question is never suppressed by the subagent preference:
         * a child Session can block the whole run and the user must see it. */
        if (subagent && !current.includeSubagents && kind !== 'action') return true
        /* A failure both errors and stops the turn. The failure alert carries the
         * reason, so the trailing completion alert for the same stop is noise. */
        if (kind === 'complete') {
          const failure = failedAt.get(sessionId)
          if (failure !== undefined && environment.now() - failure < FAILURE_QUIET_MS) return true
        }
        /* A distinct approval or question is a new demand for attention even when
         * it lands seconds after the previous one, so the request identity joins
         * the window key; completion and error alerts throttle per kind. */
        const key = `${kind}:${sessionId}:${request === undefined ? '' : request}`
        const now = environment.now()
        const previous = recent.get(key)
        if (previous !== undefined && now - previous < DEDUPE_MS) return true
        recent.set(key, now)
        if (recent.size > 200) recent.delete(recent.keys().next().value)
        return false
      }

      /**
       * Compose and deliver one alert for a Session.
       * @param kind - alert kind.
       * @param sessionId - owning Session.
       * @param detail - interaction details, or the error message for `error`.
       * @param interactionKind - domain discriminator of an action alert.
       * @returns the delivery outcome.
       */
      const emit = (kind, sessionId, detail, interactionKind) => {
        const current = settings()
        const session = environment.describe(sessionId).title
        const copy =
          kind === 'action'
            ? composeAction(interactionKind, session, detail)
            : {
                title: environment.t(`title.${kind}`, { session }),
                body: environment.t(`body.${kind}`, { session, ...detail }),
              }
        return environment.deliver({
          kind,
          interactionKind,
          sessionId,
          title: copy.title,
          body: copy.body,
          sound: current[SOUND_FIELDS[kind]],
          volume: current.volume,
          tag: `dsh:${sessionId}:${kind}`,
        })
      }

      /**
       * Compose the localized title and body of an action alert.
       * @param interactionKind - domain discriminator of the pending interaction.
       * @param session - session display title.
       * @param detail - approval/question payload.
       * @returns the composed copy.
       */
      const composeAction = (interactionKind, session, detail) => {
        const title = environment.t('title.action', { session })
        if (interactionKind === 'approval') {
          return {
            title,
            body: environment.t('body.action.approval', {
              session,
              tool: truncate(oneLine(detail.tool === undefined ? 'tool' : detail.tool), 80),
            }),
          }
        }
        if (interactionKind === 'question') {
          const question = truncate(oneLine(detail.question), 160)
          return {
            title,
            body:
              question === ''
                ? environment.t('body.action.planReview', { session })
                : environment.t('body.action.question', { session, question }),
          }
        }
        return { title, body: environment.t('body.action.planReview', { session }) }
      }

      /**
       * Read the discriminators out of a pending interaction value.
       * @param pending - forwarded pending interaction.
       * @returns its kind plus the copy details.
       */
      const readPending = (pending) => {
        const kind = typeof pending.kind === 'string' ? pending.kind : 'question'
        const detail = {}
        if (typeof pending.toolName === 'string') detail.tool = pending.toolName
        const questions = Array.isArray(pending.questions) ? pending.questions : []
        const first = questions[0]
        if (first !== undefined && typeof first.question === 'string') detail.question = first.question
        return { kind: ACTION_KINDS.includes(kind) ? kind : 'question', detail }
      }

      return {
        /**
         * Feed one Session status snapshot and alert on interesting transitions.
         * @param snapshot - `ReadonlyMap<SessionId, SessionStatus>`.
         * @returns the alerts raised during this pass.
         */
        applyStatus(snapshot) {
          const raised = []
          if (snapshot === undefined || snapshot === null || typeof snapshot.forEach !== 'function') return raised
          const alive = new Set()
          snapshot.forEach((status, sessionId) => {
            alive.add(sessionId)
            const pending = status === undefined || status === null ? undefined : status.pendingInteraction
            const pendingKey = pending === undefined || pending === null ? undefined : String(pending.key)
            const running = status !== undefined && status !== null && status.running === true
            const previous = seen.get(sessionId)
            seen.set(sessionId, { running, pendingKey })
            if (previous === undefined) return
            if (pendingKey !== undefined && pendingKey !== previous.pendingKey) {
              const interaction = readPending(pending)
              const info = environment.describe(sessionId)
              if (suppressed('action', sessionId, info.subagent, pendingKey)) return
              raised.push(emit('action', sessionId, interaction.detail, interaction.kind))
              return
            }
            if (previous.running && !running) {
              const info = environment.describe(sessionId)
              if (suppressed('complete', sessionId, info.subagent)) return
              raised.push(emit('complete', sessionId, {}, undefined))
            }
          })
          for (const sessionId of [...seen.keys()]) if (!alive.has(sessionId)) seen.delete(sessionId)
          return raised
        },
        /**
         * Alert on one live session failure.
         * @param sessionId - owning Session.
         * @param rawMessage - stringified host error.
         * @returns the alerts raised.
         */
        reportError(sessionId, rawMessage) {
          const raised = []
          const id = typeof sessionId === 'string' ? sessionId : String(sessionId === undefined ? '' : sessionId)
          const info = environment.describe(id)
          if (suppressed('error', id, info.subagent)) return raised
          failedAt.set(id, environment.now())
          if (failedAt.size > 200) failedAt.delete(failedAt.keys().next().value)
          raised.push(emit('error', id, { message: truncate(oneLine(rawMessage), 200) }, undefined))
          return raised
        },
        /** Drop all observed state, so the next snapshot is a fresh baseline. */
        reset() {
          seen.clear()
          recent.clear()
          failedAt.clear()
        },
        /** Introspection for tests and diagnostics. */
        inspect() {
          return { seen: new Map(seen), recent: new Map(recent), failedAt: new Map(failedAt) }
        },
      }
    }

    // --------------------------------------------------------------------- //
    // Settings page
    // --------------------------------------------------------------------- //

    /**
     * Render one settings row: a title, an optional description, and the control
     * on the trailing edge.
     * @param props - title, optional description, and the trailing control.
     * @returns the row element.
     */
    function Row(props) {
      return React.createElement(
        'div',
        { className: props.nested === true ? 'dsh-notify-row dsh-notify-rowNested' : 'dsh-notify-row' },
        React.createElement(
          'div',
          { className: 'dsh-notify-rowText' },
          React.createElement('div', { className: 'dsh-notify-rowTitle' }, props.title),
          props.description === undefined
            ? null
            : React.createElement('div', { className: 'dsh-notify-rowDesc' }, props.description),
        ),
        React.createElement('div', { className: 'dsh-notify-rowTrailing' }, props.children),
      )
    }

    /**
     * Render one inline alert. Used for the one thing on this page that is not a
     * preference but a state the user has to resolve: the browser permission.
     * @param props - tone, message, and an optional action.
     * @returns the alert element.
     */
    function Alert(props) {
      const Icon = props.tone === 'warn' ? IconWarningOutlineRegular : IconInfoOutlineRegular
      return React.createElement(
        'div',
        { className: `dsh-notify-alert dsh-notify-alert-${props.tone}`, role: 'alert' },
        React.createElement('span', { className: 'dsh-notify-alertIcon', 'aria-hidden': 'true' },
          React.createElement(Icon, { size: 16 }),
        ),
        React.createElement('div', { className: 'dsh-notify-alertBody' },
          React.createElement('div', { className: 'dsh-notify-alertText' }, props.message),
          props.action === undefined
            ? null
            : React.createElement(
                'div',
                { className: 'dsh-notify-alertActions' },
                React.createElement(Button, { type: 'button', variant: 'primary', size: 'sm', onClick: props.action.onClick },
                  props.action.label,
                ),
              ),
        ),
      )
    }

    /**
     * Render one event's settings: its switch, and — while the switch is on — the
     * tone it plays plus a preview. Choosing silence with the switch on is the
     * same statement as switching the event off, so the picker just offers it.
     * @param props - the event's copy, current preferences, and writers.
     * @returns the fragment holding the event's rows.
     */
    function EventGroup(props) {
      const { t, id, title, description, enabled, disabled, tone, onToggle, onTone, onPreview } = props
      const rows = [
        React.createElement(Row, {
          key: 'toggle',
          title,
          description,
        },
          React.createElement(Switch, {
            checked: enabled,
            disabled: disabled === true,
            label: title,
            onChange: onToggle,
          }),
        ),
      ]
      /* The tone row follows both switches. With this event turned off there is
       * nothing for a tone to accompany, and with notifications globally off the
       * whole page is inert, so an editable control here would be a lie. */
      if (enabled && disabled !== true) {
        rows.push(
          React.createElement(Row, {
            key: 'tone',
            nested: true,
            title: t('sound.preset.label'),
            description: tone === 'none' ? t('sound.silent.hint') : t('sound.preset.hint'),
          },
            React.createElement(SoundPicker, {
              t,
              id: `dsh-notify-sound-${id}`,
              label: title,
              value: tone,
              onChange: onTone,
            }),
            tone === 'none'
              ? null
              : React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-notify-iconButton',
                    'aria-label': t('sound.preview'),
                    title: t('sound.preview'),
                    onClick: onPreview,
                  },
                  React.createElement(IconPlayOutlineRegular, { size: 16 }),
                ),
          ),
        )
      }
      return rows
    }

    /**
     * Render one tone picker: the shipped `Menu` behind the same pill button the
     * Language row uses.
     * @param props - element id, accessible label, current preset, and writer.
     * @returns the picker element.
     */
    function SoundPicker(props) {
      const { t, id, label, value, onChange } = props
      const [open, setOpen] = React.useState(false)
      const active = t(`sound.preset.${value}`)
      const items = SOUND_IDS.map((preset) => ({ id: preset, label: t(`sound.preset.${preset}`) }))

      return React.createElement(Menu, {
        open,
        onClose: () => setOpen(false),
        items,
        selectedId: value,
        onSelect: (next) => {
          onChange(next)
          setOpen(false)
        },
        align: 'end',
        portal: true,
        anchor: React.createElement(
          'button',
          {
            type: 'button',
            id,
            className: 'dsh-notify-selectPill',
            'aria-haspopup': 'menu',
            'aria-expanded': open === true,
            'aria-label': label,
            onClick: () => setOpen((current) => !current),
          },
          active,
          React.createElement(IconChevronDownOutlineRegular, { className: 'dsh-notify-chevron' }),
        ),
      })
    }

    /**
     * Render the notification preference page. The event switches and their tones
     * share one section: a switch off and a tone set to silence mean the same
     * thing, so keeping them apart made the page state the same fact twice.
     * @param props - composed Settings slot props.
     * @returns the settings section element.
     */
    function NotificationsView(props) {
      const { t, useSettings, usePermission, setSetting, requestPermission, previewTone, sendTestNotification } = props
      const settings = useSettings((value) => value)
      const permission = usePermission((value) => value)
      const [notice, setNotice] = React.useState(null)

      /**
       * Wrap one titled group of rows. The shipped General section relies on
       * `:last-child` to drop the trailing hairline, which only works while the
       * rows are the section's own children — so each group here is its own
       * container and the hairline rule is scoped to it.
       * @param id - group key, used for the heading id.
       * @param headingKey - copy key of the heading.
       * @param children - the rows.
       * @returns the group element.
       */
      const group = (id, headingKey, children) =>
        React.createElement(
          'div',
          { className: 'dsh-notify-group', role: 'group', 'aria-labelledby': `dsh-notify-${id}-heading` },
          React.createElement(
            'h3',
            { className: 'dsh-notify-heading', id: `dsh-notify-${id}-heading` },
            t(headingKey),
          ),
          children,
        )

      /** Audition one tone and report a browser that is withholding audio. */
      const preview = (preset) => {
        const result = previewTone(preset)
        setNotice(result.state === 'blocked' ? 'sound.blocked' : null)
      }

      /* The permission is a state, not a preference: while it is unresolved the
       * page says so and offers the one action that resolves it; once it is
       * granted there is nothing left to show, so the alert disappears instead of
       * leaving a permanent "all good" row behind. */
      const permissionAlert =
        permission.permission === 'granted'
          ? null
          : React.createElement(Alert, {
              tone: permission.permission === 'default' ? 'info' : 'warn',
              message: t(`permission.${permission.permission}`),
              action:
                permission.permission === 'default'
                  ? {
                      label: t('permission.request'),
                      onClick: () => {
                        /* `request()` republishes the permission store, so the
                         * alert itself becomes the denial/unsupported message; a
                         * second notice would state the same fact twice. */
                        void requestPermission()
                      },
                    }
                  : undefined,
            })

      const events = [
        {
          id: 'complete',
          title: t('events.complete.title'),
          description: t('events.complete.description'),
          enabled: settings.notifyOnComplete,
          tone: settings.soundComplete,
          onToggle: (value) => setSetting('notifyOnComplete', value),
          onTone: (value) => setSetting('soundComplete', value),
        },
        {
          id: 'action',
          title: t('events.action.title'),
          description: t('events.action.description'),
          enabled: settings.notifyOnAction,
          tone: settings.soundAction,
          onToggle: (value) => setSetting('notifyOnAction', value),
          onTone: (value) => setSetting('soundAction', value),
        },
        {
          id: 'error',
          title: t('events.error.title'),
          description: t('events.error.description'),
          enabled: settings.notifyOnError,
          tone: settings.soundError,
          onToggle: (value) => setSetting('notifyOnError', value),
          onTone: (value) => setSetting('soundError', value),
        },
      ]

      return React.createElement(
        'div',
        { className: 'dsh-notify-section' },
        React.createElement('h2', { className: 'dsh-notify-title' }, t('page.title')),
        React.createElement('p', { className: 'dsh-notify-intro' }, t('page.intro')),

        permissionAlert,

        React.createElement(Row, {
          title: t('master.title'),
          description: t('master.description'),
        },
          React.createElement(Switch, {
            checked: settings.enabled,
            label: t('master.title'),
            onChange: (value) => setSetting('enabled', value),
          }),
        ),

        notice === 'sound.blocked'
          ? React.createElement('p', { className: 'dsh-notify-notice dsh-notify-noticeWarn', role: 'status' }, t(notice))
          : null,

        group(
          'events',
          'events.heading',
          events.map((event) =>
            React.createElement(EventGroup, {
              key: event.id,
              t,
              id: event.id,
              title: event.title,
              description: event.description,
              enabled: event.enabled,
              disabled: !settings.enabled,
              tone: event.tone,
              onToggle: event.onToggle,
              onTone: event.onTone,
              onPreview: () => preview(event.tone),
            }),
          ),
        ),

        group('behavior', 'behavior.heading', [
          React.createElement(Row, {
            key: 'background',
            title: t('onlyWhenHidden.title'),
            description: t('onlyWhenHidden.description'),
          },
            React.createElement(Switch, {
              checked: settings.onlyWhenHidden,
              disabled: !settings.enabled,
              label: t('onlyWhenHidden.title'),
              onChange: (value) => setSetting('onlyWhenHidden', value),
            }),
          ),
          React.createElement(Row, {
            key: 'subagents',
            title: t('includeSubagents.title'),
            description: t('includeSubagents.description'),
          },
            React.createElement(Switch, {
              checked: settings.includeSubagents,
              disabled: !settings.enabled,
              label: t('includeSubagents.title'),
              onChange: (value) => setSetting('includeSubagents', value),
            }),
          ),
          React.createElement(Row, {
            key: 'volume',
            title: t('sound.volume.label'),
            description: t('sound.volume.description'),
          },
            React.createElement('input', {
              id: 'dsh-notify-volume',
              className: 'dsh-notify-range',
              type: 'range',
              min: 0,
              max: 100,
              step: 5,
              value: settings.volume,
              disabled: !settings.enabled,
              'aria-label': t('sound.volume.label'),
              onChange: (event) => setSetting('volume', Number(event.target.value)),
            }),
            React.createElement(
              'span',
              { className: 'dsh-notify-volumeValue' },
              t('sound.volume.value', { value: settings.volume }),
            ),
          ),
        ]),

        group('test', 'test.heading', [
          React.createElement(
            'div',
            { key: 'actions', className: 'dsh-notify-actions' },
            React.createElement(
              Button,
              {
                type: 'button',
                variant: 'primary',
                size: 'md',
                onClick: () => {
                  const result = sendTestNotification()
                  setNotice(result.shown ? 'notice.test.shown' : 'notice.test.blocked')
                },
              },
              t('sound.test'),
            ),
            notice === null || !notice.startsWith('notice.')
              ? null
              : React.createElement('span', { className: 'dsh-notify-notice', role: 'status' }, t(notice)),
          ),
        ]),

        React.createElement('p', { className: 'dsh-notify-footnote' }, t('page.footnote')),
      )
    }

    /**
     * Stylesheet of the settings page. Metrics, hairlines, and radii mirror the
     * shipped Settings sections (16px rows separated by a 0.5px `border-l2`
     * line, 16px/500 page title, 13px/600 group headings, 36px pills), and
     * every color is a host alias token so the page follows the active theme.
     * Toggles, menu, buttons, and icons are the shipped primitives, so nothing
     * here restyles a control the rest of Settings owns.
     */
    const CSS = `
.dsh-notify-section{box-sizing:border-box;max-width:720px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px;min-width:0}
.dsh-notify-title{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}
.dsh-notify-intro{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}
.dsh-notify-footnote{margin:0;padding-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsh-notify-group{display:flex;flex-direction:column;min-width:0;margin-top:12px}
.dsh-notify-group>.dsh-notify-heading{margin:0 0 4px}
.dsh-notify-heading{margin:0;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsh-notify-row{border-bottom:.5px solid var(--dsw-alias-border-l2);display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;min-width:0}
.dsh-notify-group>.dsh-notify-row:last-child{border-bottom:none}
.dsh-notify-rowNested{padding:12px 0 12px 20px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dsh-notify-rowNested .dsh-notify-rowTitle{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsh-notify-rowText{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}
.dsh-notify-rowTitle{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsh-notify-rowDesc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-notify-rowTrailing{display:inline-flex;align-items:center;gap:8px;flex:none}
.dsh-notify-alert{display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border-radius:var(--dsw-radius-lg);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.dsh-notify-alert-info{border-color:var(--dsw-alias-border-l2)}
.dsh-notify-alert-warn{border-color:var(--dsw-alias-state-warn-primary)}
.dsh-notify-alertIcon{flex:none;margin-top:2px;color:var(--dsw-alias-label-secondary)}
.dsh-notify-alert-warn .dsh-notify-alertIcon{color:var(--dsw-alias-state-warn-primary)}
.dsh-notify-alertBody{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-notify-alertText{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dsh-notify-alertActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-notify-iconButton{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:36px;height:36px;padding:0;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer}
.dsh-notify-iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-notify-iconButton:active:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-notify-iconButton:disabled{opacity:.4;cursor:default}
.dsh-notify-iconButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-notify-selectPill{box-sizing:border-box;display:inline-flex;align-items:center;gap:12px;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);cursor:pointer}
.dsh-notify-selectPill:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-notify-selectPill:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-notify-chevron{flex:none}
.dsh-notify-range{width:180px;accent-color:var(--dsw-alias-brand-primary)}
.dsh-notify-range:disabled{opacity:.5;cursor:default}
.dsh-notify-volumeValue{min-width:44px;text-align:right;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dsh-notify-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:16px 0 0}
.dsh-notify-notice{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-notify-noticeWarn{color:var(--dsw-alias-state-warn-label)}
`

    // --------------------------------------------------------------------- //
    // Plugin body
    // --------------------------------------------------------------------- //

    /** Context shape guards so a partial profile never crashes the plugin. */
    const safe = (operation) => {
      try {
        return operation()
      } catch (error) {
        console.error('[agent-notifications]', error)
        return undefined
      }
    }

    /**
     * Install preferences, the alert engine, and the Settings page.
     * @param ctx - Client plugin context.
     */
    function apply(ctx) {
      const globalObject = typeof window !== 'undefined' ? window : undefined
      const doc = typeof document !== 'undefined' ? document : undefined

      let storage
      try {
        storage = globalObject === undefined ? undefined : globalObject.localStorage
      } catch (error) {
        /* Storage can be denied by policy; preferences then live in memory. */
        storage = undefined
      }

      const store = createSettingsStore(storage)
      const permissionStore = createPermissionStore({ globalObject })
      const player = createSoundPlayer({
        createContext:
          globalObject === undefined || typeof globalObject.AudioContext !== 'function'
            ? () => undefined
            : () => new globalObject.AudioContext(),
      })

      const t = (key, params) => safe(() => ctx.locale.bind(NS)(key, params)) ?? key

      /* `uiWorkspace` is optional: a profile without the workspace UI still gets
       * notifications, it just cannot reveal the Session from the notification. */
      const openSession = (sessionId) => {
        const workspace = safe(() => ctx.get('uiWorkspace'))
        if (workspace !== undefined && workspace !== null && typeof workspace.openSession === 'function') {
          safe(() => workspace.openSession(sessionId))
        }
      }

      const dispatcher = createDispatcher({
        permission: () => permissionStore.getSnapshot().permission,
        notify: (title, options) => permissionStore.construct(title, options),
        play: (sound, volume) => player.play(sound, volume),
        focus: () => safe(() => globalObject?.focus?.()),
        openSession,
      })

      /** Read the Session title and delegation facts from the catalog. */
      const describe = (sessionId) => {
        let row
        safe(() => {
          const list = ctx.sessions.list.getSnapshot()
          row = list === undefined || list.byId === undefined ? undefined : list.byId[sessionId]
        })
        const title =
          row === undefined || row === null
            ? sessionId
            : truncate(oneLine(row.displayTitle ?? row.title ?? sessionId), 80)
        const subagent = row !== undefined && row !== null && (row.origin === 'subagent' || row.parentId !== undefined)
        return { title, subagent: subagent === true }
      }

      const engine = createEngine({
        store,
        environment: {
          /* The page counts as attended only when its tab is visible AND the
           * window has focus: switching to another window or app keeps
           * `visibilityState` at `visible`, which would otherwise hide exactly
           * the notifications the preference exists to deliver. */
          isHidden: () => {
            if (doc === undefined) return true
            if (doc.visibilityState === 'hidden') return true
            return typeof doc.hasFocus === 'function' ? doc.hasFocus() === false : false
          },
          now: () => Date.now(),
          describe,
          t,
          deliver: (request) => dispatcher.deliver(request),
        },
      })

      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'agent-notifications: dictionaries')

      /* An audio context needs a user gesture before it may start, and browsers
       * also re-suspend one that sat idle. Keeping the listeners installed (rather
       * than removing them after the first gesture) is what makes the *next*
       * alert audible instead of the tab going permanently silent once the
       * context has been suspended in the background. */
      ctx.effect(() => {
        if (globalObject === undefined || typeof globalObject.addEventListener !== 'function') return () => {}
        const unlock = () => {
          player.unlock()
        }
        globalObject.addEventListener('pointerdown', unlock, true)
        globalObject.addEventListener('keydown', unlock, true)
        globalObject.addEventListener('focus', unlock, true)

        /* Returning to the tab is the cheapest moment to resume: the browser
         * treats a focus change as a gesture for the audio policy in Chrome. */
        const onVisible = () => {
          if (doc !== undefined && doc.visibilityState === 'visible') player.wake()
        }
        if (doc !== undefined && typeof doc.addEventListener === 'function') {
          doc.addEventListener('visibilitychange', onVisible)
        }
        return () => {
          globalObject.removeEventListener('pointerdown', unlock, true)
          globalObject.removeEventListener('keydown', unlock, true)
          globalObject.removeEventListener('focus', unlock, true)
          if (doc !== undefined && typeof doc.removeEventListener === 'function') {
            doc.removeEventListener('visibilitychange', onVisible)
          }
        }
      }, 'agent-notifications: audio unlock')

      /* Session status is the UI plugin's own derived authority over running,
       * pending interaction, and unread completion, so observing it keeps this
       * plugin independent of the approval and question waterfall ordering. */
      ctx.effect(() => {
        const source = ctx.uiSession?.sessionStatus
        if (source === undefined || typeof source.subscribe !== 'function') return () => {}
        const read = () => safe(() => source.getSnapshot())
        engine.applyStatus(read())
        const dispose = source.subscribe(() => {
          safe(() => engine.applyStatus(read()))
        })
        return () => {
          if (typeof dispose === 'function') dispose()
          engine.reset()
        }
      }, 'agent-notifications: session status')

      ctx.effect(() => {
        let dispose
        safe(() => {
          dispose = ctx.remote.$on('api-session/error', (sessionId, message) => {
            safe(() => engine.reportError(sessionId, message))
          })
        })
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      }, 'agent-notifications: session errors')

      ctx.effect(() => {
        if (doc === undefined || doc.head === undefined) return () => {}
        const tag = doc.createElement('style')
        /* `data-plugin` is the id `client-modules` uses to strip a replaced
         * entry's styles; the sibling attribute keeps it greppable while
         * debugging in the page. */
        tag.dataset.plugin = 'dsh-plugin-agent-notifications'
        tag.dataset.pluginCss = 'dsh-plugin-agent-notifications/notifications.css'
        tag.textContent = CSS
        doc.head.appendChild(tag)
        return () => {
          if (typeof tag.remove === 'function') tag.remove()
        }
      }, 'agent-notifications: styles')

      const requestPermission = async () => {
        const result = await permissionStore.request()
        return result
      }

      /**
       * Play one preset at the shared volume, for the preview buttons.
       * @param presetId - tone to audition.
       * @returns `{ played, state }`: whether notes were scheduled, and whether
       * the browser is still withholding audio.
       */
      const previewTone = (presetId) => {
        const current = store.getSnapshot()
        const played = player.play(presetId, current.volume)
        return { played, state: player.state() }
      }

      const sendTestNotification = () => {
        player.unlock()
        const current = store.getSnapshot()
        return dispatcher.deliver({
          kind: 'test',
          sessionId: 'test',
          title: t('title.test'),
          body: t('body.test'),
          sound: current.soundComplete,
          volume: current.volume,
          tag: 'dsh:test',
        })
      }

      if (ctx.slots !== undefined && typeof ctx.slots.inject === 'function') {
        ctx.effect(() =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'agent-notifications',
                order: 30,
                label: () => safe(() => ctx.locale.bind(NS)('nav')) ?? 'Notifications',
                locale: NS,
                inject: () => ({
                  hooks: { settings: store, permission: permissionStore },
                  setSetting: (field, value) => store.update({ [field]: value }),
                  requestPermission,
                  previewTone,
                  sendTestNotification,
                }),
              },
              NotificationsView,
            ),
          ),
          'agent-notifications: settings page',
        )
      }

      ctx.effect(() => () => player.dispose(), 'agent-notifications: audio context')
    }

    return { inject, apply, __internals: {
      NS,
      STORAGE_KEY,
      DEDUPE_MS,
      DEFAULTS,
      SOUND_IDS,
      SOUND_FIELDS,
      TONES,
      EVENT_KINDS,
      dictionaries: { en, zh },
      normalizeSettings,
      clampVolume,
      truncate,
      oneLine,
      createSettingsStore,
      createPermissionStore,
      createSoundPlayer,
      createDispatcher,
      createEngine,
      NotificationsView,
      CSS,
    } }
  },
})
