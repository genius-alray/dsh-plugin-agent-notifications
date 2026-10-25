/**
 * Bundle-level tests: the manifest, the Loader patch, the locale resources, and
 * the Host half must agree with each other and with the Client bundle id.
 */

import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { apply, name } from '../index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8')
const manifest = JSON.parse(read('package.json'))

test('host: the row applies without services and without configuration', () => {
  assert.equal(name, 'agent-notifications')
  assert.doesNotThrow(() => apply({}, undefined))
  assert.doesNotThrow(() => apply())
})

test('manifest: the bundle declares a patch and the web Client half', () => {
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.immediately, true, 'the engine must prefetch before the first status snapshot')
  assert.ok(Array.isArray(manifest.dsh.client.inject))
  for (const dependency of manifest.dsh.client.inject) {
    assert.match(dependency, /^@deepseek-ai\/dsh-client-/, 'only Client package ids order activation')
  }
})

test('manifest: every runtime file is exported and listed', () => {
  const runtime = ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json']
  for (const file of runtime) assert.ok(statSync(join(ROOT, file)).isFile(), `${file} exists`)

  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.icon, './icon.svg')

  const patterns = manifest.files
  for (const file of runtime) {
    const covered = patterns.some((pattern) => {
      if (!pattern.includes('*')) return pattern === file
      const prefix = pattern.slice(0, pattern.indexOf('*'))
      return file.startsWith(prefix)
    })
    assert.ok(covered, `${file} is covered by files[]`)
  }
})

test('patch: one insert row naming the package itself', () => {
  const text = read('cordis.patch.yml')
  assert.match(text, /^-\s+insert:/m)
  assert.match(text, /id:\s*agent-notifications/)
  assert.ok(text.includes(`name: '${manifest.name}'`), 'the patch row names this package')
  assert.ok(!/\bconfig:/.test(text), 'the bundle carries no Host configuration')

  const rows = text.split('\n').filter((line) => /^\s*-?\s*id:/.test(line))
  assert.equal(rows.length, 1, 'exactly one row is inserted')
})

test('client bundle: registers the package id and exports the plugin face', () => {
  const source = read('client.js')
  assert.match(source, /window\.__ModuleLoader__\.load\(/)
  assert.ok(source.includes(`id: '${manifest.name}'`), 'the factory id is the package name the Loader resolves')
  assert.match(source, /return \{ inject, apply, __internals: \{/)
  assert.ok(!/from '@deepseek-ai\/dsh-client-ui-primitives'/.test(source), 'no Harness Client package import')
  assert.ok(!/^\s*<[A-Za-z]/m.test(source), 'no JSX: the artifact is plain JavaScript')
  assert.ok(!source.includes('</'), 'no JSX closing tags')
  assert.ok(!source.includes('/>'), 'no JSX self-closing tags')
})

test('locale: both dictionaries declare title and description', () => {
  for (const locale of ['en', 'zh']) {
    const document = JSON.parse(read(`locale/${locale}.json`))
    assert.equal(typeof document.meta.title, 'string')
    assert.equal(typeof document.meta.description, 'string')
    assert.ok(document.meta.title.length > 0)
    assert.ok(document.meta.description.length > 20, 'the description explains the capability')
  }
  assert.notEqual(
    JSON.parse(read('locale/en.json')).meta.title,
    JSON.parse(read('locale/zh.json')).meta.title,
    'the Chinese locale is translated, not copied',
  )
})

test('icon: a bounded, self-describing SVG', () => {
  const icon = read('icon.svg')
  const bytes = statSync(join(ROOT, 'icon.svg')).size
  assert.ok(bytes <= 256 * 1024, `icon.svg is ${bytes} bytes`)
  assert.match(icon, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(icon, /viewBox="0 0 64 64"/)
  assert.match(icon, /<title>[^<]+<\/title>/)
})

test('readme: documents the delivered behavior and its limits', () => {
  const readme = read('README.md')
  for (const topic of ['Notifications', '提示音', '权限', '标签页', '音量']) {
    assert.ok(readme.toLowerCase().includes(topic.toLowerCase()), `README covers "${topic}"`)
  }
})
