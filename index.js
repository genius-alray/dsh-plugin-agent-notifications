/**
 * Host half of the agent-notification bundle.
 *
 * The feature is browser-only: the Client half listens to Session UI status and
 * raises `Notification`s through the page. This Host entry exists so the Loader
 * can mount the row and therefore discover the package's `dsh.client` half; it
 * deliberately registers nothing and holds no configuration (the preferences
 * live in each browser, where the notification permission lives too).
 */

/** Bundle row id, mirrored by `cordis.patch.yml`. */
export const name = 'agent-notifications'

/**
 * Mount the row without contributing Host behavior.
 * @returns {void}
 */
export function apply() {}
