#!/usr/bin/env node
// Commands used by the native Mac app. Never print OAuth token material.
import { createSessionStore, defaultStoreDir, keyForSession, startOAuthLogin } from '../lib/oauth.mjs'

const store = createSessionStore({ dir: process.env.MAGPIE_QUICK_DATA_DIR || defaultStoreDir() })
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const command = process.argv[2]

if (command === 'list') {
  emit({ type: 'accounts', accounts: store.list().map((key) => {
    const s = store.get(key)
    return { id: key, label: s?.email || s?.display_name || s?.account_name || key, provider: s?.provider || 'social' }
  }) })
} else if (command === 'remove') {
  const id = process.argv[3]
  if (!id || !store.list().includes(id)) { emit({ type: 'error', message: '未找到账号' }); process.exitCode = 1 }
  else { store.remove(id); emit({ type: 'removed', id }) }
} else if (command === 'login') {
  try {
    const { url, done, cancel } = await startOAuthLogin({ dir: process.env.MAGPIE_QUICK_DATA_DIR || defaultStoreDir() })
    const onStop = () => { cancel(); process.exit(1) }
    process.once('SIGINT', onStop)
    process.once('SIGTERM', onStop)
    emit({ type: 'login_url', url })
    const session = await done
    const id = keyForSession(session)
    store.set(id, session)
    emit({ type: 'login_ok', id, label: session.email || session.display_name || id })
    process.removeListener('SIGINT', onStop)
    process.removeListener('SIGTERM', onStop)
  } catch (e) {
    emit({ type: 'error', message: String(e?.message || e).slice(0, 500) })
    process.exitCode = 1
  }
} else {
  emit({ type: 'error', message: 'Unknown command: use login, list, remove' })
  process.exitCode = 1
}
