import { useState, useEffect } from 'react'
import type { Connection } from '../types'

const API = 'http://localhost:3000'

interface Props {
  connection?: Connection  // undefined → create mode
  onClose:   () => void
  onSaved:   (conn: Connection) => void
}

interface FormState {
  name:         string
  host:         string
  port:         string
  username:     string
  auth_type:    'key' | 'password'
  private_key:  string
  password:     string
  auto_approve: boolean
}

type TestState = { status: 'idle' } | { status: 'testing' } | { status: 'ok' } | { status: 'fail'; error: string }

export function ConnectionModal({ connection, onClose, onSaved }: Props) {
  const isEdit = Boolean(connection)

  const [form, setForm] = useState<FormState>({
    name:         connection?.name      ?? '',
    host:         connection?.host      ?? '',
    port:         String(connection?.port ?? 22),
    username:     connection?.username  ?? '',
    auth_type:    connection?.auth_type ?? 'key',
    private_key:  '',
    password:     '',
    auto_approve: connection?.auto_approve ?? false,
  })

  const [test,   setTest]   = useState<TestState>({ status: 'idle' })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  // Reset test result when credentials change.
  useEffect(() => { setTest({ status: 'idle' }) }, [form.host, form.port, form.username, form.auth_type, form.private_key, form.password])

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
    setError(null)
  }

  const handleInputChange = (key: keyof FormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      const value = e.target.type === 'checkbox'
        ? (e.target as HTMLInputElement).checked
        : e.target.value
      setField(key, value as any)
    }

  const canTest = Boolean(form.host && form.username && form.auth_type &&
    (form.auth_type === 'key' ? form.private_key : form.password))

  const handleTest = async () => {
    setTest({ status: 'testing' })
    try {
      const res = await fetch(`${API}/api/connections/test`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host:        form.host,
          port:        parseInt(form.port) || 22,
          username:    form.username,
          auth_type:   form.auth_type,
          private_key: form.auth_type === 'key'      ? form.private_key : undefined,
          password:    form.auth_type === 'password' ? form.password    : undefined,
        }),
      })
      const data = await res.json()
      setTest(data.ok ? { status: 'ok' } : { status: 'fail', error: data.error ?? 'Unknown error' })
    } catch {
      setTest({ status: 'fail', error: 'Network error' })
    }
  }

  const handleSave = async () => {
    if (!form.name || !form.host || !form.username || !form.auth_type) {
      setError('Name, host, username and auth type are required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const body: Record<string, unknown> = {
        name:         form.name,
        host:         form.host,
        port:         parseInt(form.port) || 22,
        username:     form.username,
        auth_type:    form.auth_type,
        auto_approve: form.auto_approve,
      }
      // Only send credentials if provided (edit: leave blank to keep existing).
      if (form.auth_type === 'key'      && form.private_key) body.private_key = form.private_key
      if (form.auth_type === 'password' && form.password)    body.password    = form.password

      const url    = isEdit ? `${API}/api/connections/${connection!.id}` : `${API}/api/connections`
      const method = isEdit ? 'PUT' : 'POST'

      const res  = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json()

      if (!res.ok) { setError(data.error ?? 'Failed to save'); return }
      onSaved(data as Connection)
    } catch {
      setError('Network error')
    } finally {
      setSaving(false)
    }
  }

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="modal-header">
          <span className="modal-title">{isEdit ? 'Edit Connection' : 'Add Connection'}</span>
          <button className="detail-close" onClick={onClose}>✕</button>
        </div>

        {/* Body */}
        <div className="modal-body">
          <div className="form-field">
            <label className="form-label">Name</label>
            <input className="form-input" value={form.name} onChange={handleInputChange('name')}
              placeholder="e.g. prod-web-01" autoFocus />
          </div>

          <div className="form-row">
            <div className="form-field" style={{ flex: 3 }}>
              <label className="form-label">Host</label>
              <input className="form-input" value={form.host} onChange={handleInputChange('host')}
                placeholder="192.168.1.100 or hostname" />
            </div>
            <div className="form-field" style={{ flex: 1 }}>
              <label className="form-label">Port</label>
              <input className="form-input" type="number" value={form.port} onChange={handleInputChange('port')}
                min={1} max={65535} />
            </div>
          </div>

          <div className="form-field">
            <label className="form-label">Username</label>
            <input className="form-input" value={form.username} onChange={handleInputChange('username')}
              placeholder="root" />
          </div>

          <div className="form-field">
            <label className="form-label">Auth Type</label>
            <select className="form-input form-select" value={form.auth_type}
              onChange={handleInputChange('auth_type')}>
              <option value="key">SSH Key</option>
              <option value="password">Password</option>
            </select>
          </div>

          {form.auth_type === 'key' ? (
            <div className="form-field">
              <label className="form-label">Private Key (PEM)</label>
              <textarea className="form-input form-textarea" value={form.private_key}
                onChange={handleInputChange('private_key')}
                placeholder={isEdit ? 'Leave blank to keep existing key' : '-----BEGIN OPENSSH PRIVATE KEY-----\n...'} />
            </div>
          ) : (
            <div className="form-field">
              <label className="form-label">Password</label>
              <input className="form-input" type="password" value={form.password}
                onChange={handleInputChange('password')}
                placeholder={isEdit ? 'Leave blank to keep existing password' : ''} />
            </div>
          )}

          <div className="form-field">
            <label className="toggle-row">
              <input type="checkbox" checked={form.auto_approve}
                onChange={handleInputChange('auto_approve')} />
              <div>
                <div className="toggle-label">Auto-approve</div>
                <div className="toggle-hint">Automatically approve all AI commands for this connection without human review</div>
              </div>
            </label>
          </div>
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={handleTest}
            disabled={test.status === 'testing' || !canTest}
            title={canTest ? undefined : 'Fill in host, username and credentials to test'}>
            {test.status === 'testing' ? 'Testing…' : 'Test'}
          </button>

          {test.status === 'ok'   && <span className="test-result ok">✓ Connected</span>}
          {test.status === 'fail' && <span className="test-result fail" title={test.error}>✗ {test.error}</span>}

          <div style={{ flex: 1 }} />

          {error && <span className="form-error">{error}</span>}

          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

      </div>
    </div>
  )
}
