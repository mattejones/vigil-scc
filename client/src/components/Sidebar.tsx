import { useState, useEffect } from 'react'
import type { Connection, RemoteRunInfo } from '../types'

interface Props {
  connections:          Connection[]
  pendingCount:         number
  onAddConnection:      () => void
  onEditConnection:     (conn: Connection) => void
  onDeleteConnection:   (id: string) => void
  onConnect:            (id: string) => void
  onDisconnect:         (id: string) => void
  onToggleAutoApprove:  (conn: Connection) => void
  onListOrphans:        (id: string) => Promise<RemoteRunInfo[] | string>
  onStopOrphan:         (id: string, name: string) => Promise<string | null>
}

function relativeTime(iso?: string): string {
  if (!iso) return 'never'
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60)    return `${diff}s ago`
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

// Runs left on the host that no token tracks (e.g. after a lost session).
function OrphanRuns({ conn, onList, onStop }: {
  conn:   Connection
  onList: () => Promise<RemoteRunInfo[] | string>
  onStop: (name: string) => Promise<string | null>
}) {
  const [runs,     setRuns]     = useState<RemoteRunInfo[] | null>(null)
  const [error,    setError]    = useState<string | null>(null)
  const [stopping, setStopping] = useState<string | null>(null)

  const apply = (result: RemoteRunInfo[] | string) => {
    if (typeof result === 'string') { setError(result); setRuns([]) }
    else { setError(null); setRuns(result) }
  }

  const load = async () => apply(await onList())

  useEffect(() => {
    let cancelled = false
    onList().then(result => { if (!cancelled) apply(result) })
    return () => { cancelled = true }
  }, [conn.id])  // eslint-disable-line react-hooks/exhaustive-deps

  const stop = async (name: string) => {
    setStopping(name)
    const err = await onStop(name)
    setStopping(null)
    if (err) setError(err)
    await load()
  }

  if (runs === null) return <div className="orphan-list"><div className="orphan-empty">Checking host…</div></div>

  return (
    <div className="orphan-list">
      {error && <div className="conn-error">{error}</div>}
      {runs.length === 0 && !error && <div className="orphan-empty">No untracked runs on this host</div>}
      {runs.map(run => (
        <div key={run.dir} className="orphan-row" title={run.dir}>
          <span className={`orphan-state ${run.state}`}>{run.state}{run.state === 'exited' ? ` ${run.exit_code}` : ''}</span>
          <span className="orphan-name">{run.name}</span>
          <button className="conn-btn-sm conn-btn-disconnect" disabled={stopping === run.name} onClick={() => stop(run.name)}>
            {stopping === run.name ? '…' : run.state === 'alive' ? 'Stop & clean' : 'Clean'}
          </button>
        </div>
      ))}
    </div>
  )
}

function ConnRow({ conn, onEdit, onDelete, onConnect, onDisconnect, onToggleAutoApprove, onListOrphans, onStopOrphan }: {
  conn:                Connection
  onEdit:              () => void
  onDelete:            () => void
  onConnect:           () => void
  onDisconnect:        () => void
  onToggleAutoApprove: () => void
  onListOrphans:       () => Promise<RemoteRunInfo[] | string>
  onStopOrphan:        (name: string) => Promise<string | null>
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [connecting,    setConnecting]    = useState(false)
  const [showRuns,      setShowRuns]      = useState(false)

  // Clear connecting spinner when status resolves
  useEffect(() => { setConnecting(false) }, [conn.status])

  const handleConnect = () => {
    setConnecting(true)
    onConnect()
  }

  const handleDelete = () => {
    if (!confirmDelete) { setConfirmDelete(true); return }
    onDelete()
  }

  return (
    <div className="conn-row">
      {/* Main row: dot + name + action icons */}
      <div className="conn-row-main">
        <span className={`conn-dot ${conn.status.toLowerCase()}`} />
        <div className="conn-info">
          <div className="conn-name-row">
            <span className="conn-name" title={conn.name}>{conn.name}</span>
            <div className="conn-actions">
              <button className="conn-btn-icon" onClick={onEdit} title="Edit">✎</button>
              <button
                className={`conn-btn-icon ${confirmDelete ? 'danger' : ''}`}
                onClick={handleDelete}
                onBlur={() => setConfirmDelete(false)}
                title={confirmDelete ? 'Click again to confirm delete' : 'Delete'}
              >
                {confirmDelete ? '?' : '✕'}
              </button>
            </div>
          </div>
          <div className="conn-host">{conn.username}@{conn.host}:{conn.port}</div>
        </div>
      </div>

      {/* Controls row: connect/disconnect + auto-approve */}
      <div className="conn-controls">
        {conn.status === 'CONNECTED' ? (
          <>
            <button className="conn-btn-sm conn-btn-disconnect" onClick={onDisconnect}>
              ● Disconnect
            </button>
            <button className={`conn-btn-sm conn-btn-disconnect ${showRuns ? 'active' : ''}`}
              onClick={() => setShowRuns(v => !v)} title="Runs left on the host that no task is tracking">
              Runs
            </button>
          </>
        ) : (
          <button
            className={`conn-btn-sm conn-btn-connect ${conn.status === 'ERROR' ? 'error' : ''}`}
            onClick={handleConnect}
            disabled={connecting}
          >
            {connecting ? '…' : conn.status === 'ERROR' ? '↺ Retry' : '→ Connect'}
          </button>
        )}

        <button
          className={`conn-btn-sm conn-btn-auto ${conn.auto_approve ? 'active' : ''}`}
          onClick={onToggleAutoApprove}
          title={conn.auto_approve ? 'Auto-approve ON — click to disable' : 'Auto-approve OFF — click to enable'}
        >
          ⚡ AUTO
        </button>
      </div>

      {showRuns && conn.status === 'CONNECTED' && (
        <OrphanRuns conn={conn} onList={onListOrphans} onStop={onStopOrphan} />
      )}

      {/* Connection error message */}
      {conn.status === 'ERROR' && conn.error && (
        <div className="conn-error">{conn.error}</div>
      )}

      {conn.status === 'CONNECTED' && conn.last_connected_at && (
        <div className="conn-since">Connected {relativeTime(conn.last_connected_at)}</div>
      )}
    </div>
  )
}

export function Sidebar({
  connections,
  pendingCount,
  onAddConnection,
  onEditConnection,
  onDeleteConnection,
  onConnect,
  onDisconnect,
  onToggleAutoApprove,
  onListOrphans,
  onStopOrphan,
}: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-heading">
        <span>Connections</span>
        <button className="btn-add-conn" onClick={onAddConnection}>+ Add</button>
      </div>

      <div className="sidebar-scroll">
        {connections.length === 0 ? (
          <div className="sidebar-empty">
            No connections yet.<br />
            Click <strong>+ Add</strong> to register one, or ask the AI to add one via <code style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>vigil_add_connection</code>.
          </div>
        ) : (
          connections.map(conn => (
            <ConnRow
              key={conn.id}
              conn={conn}
              onEdit={() => onEditConnection(conn)}
              onDelete={() => onDeleteConnection(conn.id)}
              onConnect={() => onConnect(conn.id)}
              onDisconnect={() => onDisconnect(conn.id)}
              onToggleAutoApprove={() => onToggleAutoApprove(conn)}
              onListOrphans={() => onListOrphans(conn.id)}
              onStopOrphan={(name) => onStopOrphan(conn.id, name)}
            />
          ))
        )}
      </div>

      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', marginTop: 'auto' }}>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600, marginBottom: 6 }}>
          Queue
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          {pendingCount > 0
            ? <span style={{ color: 'var(--amber)' }} className="pulse">● {pendingCount} awaiting approval</span>
            : <span>Queue clear</span>
          }
        </div>
      </div>
    </aside>
  )
}
