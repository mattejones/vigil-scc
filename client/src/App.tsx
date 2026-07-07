import { useEffect, useState, useCallback } from 'react'
import { io } from 'socket.io-client'
import type { Token, Connection } from './types'
import { Sidebar }           from './components/Sidebar'
import { TokenCard }         from './components/TokenCard'
import { TokenDetail }       from './components/TokenDetail'
import { ConnectionModal }   from './components/ConnectionModal'

const API  = 'http://localhost:3000'
const socket = io(API)

const ACTIVE_STATUSES   = ['PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'WAITING_FOR_INPUT']
const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'REJECTED']
const MAX_RECENT = 20

export default function App() {
  const [tokens,      setTokens]      = useState<Token[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [selectedId,  setSelectedId]  = useState<string | null>(null)
  const [connected,   setConnected]   = useState(false)

  // Modal state: null = closed, undefined = create mode, Connection = edit mode
  const [modalConn, setModalConn] = useState<Connection | undefined | null>(null)

  // ── Fetch helpers ─────────────────────────────────────────────────────────

  const fetchTokens = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/tokens`)
      const data: Token[] = await res.json()
      setTokens(data)
    } catch { /* server may not be ready yet */ }
  }, [])

  const fetchConnections = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/connections`)
      const data: Connection[] = await res.json()
      setConnections(data)
    } catch { /* ignore */ }
  }, [])

  // ── Mount ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    fetchTokens()
    fetchConnections()

    socket.on('connect',    () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))

    // Token events — upsert into state
    const tokenEvents = [
      'token:created', 'token:approved', 'token:rejected',
      'token:started', 'token:command:complete', 'token:completed', 'token:failed',
    ]

    const handleTokenEvent = (payload: Token | { token: Token }) => {
      const token = 'token' in payload ? payload.token : payload
      setTokens(prev => {
        const idx = prev.findIndex(t => t.id === token.id)
        if (idx === -1) return [token, ...prev]
        const next = [...prev]
        next[idx] = token
        return next
      })
    }

    tokenEvents.forEach(ev => socket.on(ev, handleTokenEvent))

    // Connection CRUD events — update state directly from payload
    socket.on('connection:created', (conn: Connection) => {
      setConnections(prev => [...prev, conn].sort((a, b) => a.name.localeCompare(b.name)))
    })
    socket.on('connection:updated', (conn: Connection) => {
      setConnections(prev => prev.map(c => c.id === conn.id ? conn : c))
    })
    socket.on('connection:deleted', ({ id }: { id: string }) => {
      setConnections(prev => prev.filter(c => c.id !== id))
    })

    // Status-only connection events — re-fetch to get updated status/error
    socket.on('connection:connected',    fetchConnections)
    socket.on('connection:disconnected', fetchConnections)
    socket.on('connection:error',        fetchConnections)

    return () => {
      tokenEvents.forEach(ev => socket.off(ev, handleTokenEvent))
      socket.off('connection:created')
      socket.off('connection:updated')
      socket.off('connection:deleted')
      socket.off('connection:connected',    fetchConnections)
      socket.off('connection:disconnected', fetchConnections)
      socket.off('connection:error',        fetchConnections)
    }
  }, [fetchTokens, fetchConnections])

  // ── Token actions ─────────────────────────────────────────────────────────

  const approve = async (tokenId: string) => {
    await fetch(`${API}/api/tokens/${tokenId}/approve`, { method: 'POST' })
  }

  const reject = async (tokenId: string) => {
    const note = window.prompt('Rejection note (optional):')
    if (note === null) return // cancelled
    await fetch(`${API}/api/tokens/${tokenId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    })
  }

  // ── Connection actions ────────────────────────────────────────────────────

  const handleConnect = async (id: string) => {
    await fetch(`${API}/api/connections/${id}/connect`, { method: 'POST' })
  }

  const handleDisconnect = async (id: string) => {
    await fetch(`${API}/api/connections/${id}/disconnect`, { method: 'POST' })
  }

  const handleDeleteConnection = async (id: string) => {
    const res = await fetch(`${API}/api/connections/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json()
      alert(data.error ?? 'Failed to delete connection')
    }
  }

  const handleToggleAutoApprove = async (conn: Connection) => {
    await fetch(`${API}/api/connections/${conn.id}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ auto_approve: !conn.auto_approve }),
    })
  }

  const handleModalSaved = (conn: Connection) => {
    setConnections(prev => {
      const idx = prev.findIndex(c => c.id === conn.id)
      if (idx === -1) return [...prev, conn].sort((a, b) => a.name.localeCompare(b.name))
      const next = [...prev]
      next[idx] = conn
      return next
    })
    setModalConn(null)
  }

  // ── Derived state ─────────────────────────────────────────────────────────

  const active   = tokens.filter(t => ACTIVE_STATUSES.includes(t.status))
  const recent   = tokens.filter(t => TERMINAL_STATUSES.includes(t.status)).slice(0, MAX_RECENT)
  const pending  = tokens.filter(t => t.status === 'PENDING_APPROVAL')
  const selected = tokens.find(t => t.id === selectedId) ?? null

  const connName = (id: string) =>
    connections.find(c => c.id === id)?.name ?? id.slice(0, 8)

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Header */}
      <header className="header">
        <span className="header-logo">VIGIL</span>
        <div className="header-sep" />
        <span className="header-stat">
          <span className={`dot ${connected ? 'green' : ''}`} />
          {connected ? 'live' : 'reconnecting'}
        </span>
        {pending.length > 0 && (
          <>
            <div className="header-sep" />
            <span className="header-stat">
              <span className="dot amber pulse" />
              {pending.length} pending approval
            </span>
          </>
        )}
        <div className="header-spacer" />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
          SSH Command Center
        </span>
      </header>

      {/* Layout */}
      <div className="layout">
        <Sidebar
          connections={connections}
          pendingCount={pending.length}
          onAddConnection={() => setModalConn(undefined)}
          onEditConnection={(conn) => setModalConn(conn)}
          onDeleteConnection={handleDeleteConnection}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          onToggleAutoApprove={handleToggleAutoApprove}
        />

        <div className="main">
          {/* Queue */}
          <div className="queue">
            {tokens.length === 0 ? (
              <div className="queue-empty">
                <div className="queue-empty-icon">◎</div>
                <div>No tasks yet</div>
                <div style={{ fontSize: 11, maxWidth: 260, textAlign: 'center', lineHeight: 1.7 }}>
                  Ask the AI to run something. Commands will appear here waiting for your approval.
                </div>
              </div>
            ) : (
              <>
                {active.length > 0 && (
                  <>
                    <div className="queue-section-label">Active</div>
                    {active.map(token => (
                      <TokenCard
                        key={token.id}
                        token={token}
                        selected={token.id === selectedId}
                        connName={connName(token.connection_id)}
                        onSelect={() => setSelectedId(prev => prev === token.id ? null : token.id)}
                        onApprove={() => approve(token.id)}
                        onReject={() => reject(token.id)}
                      />
                    ))}
                  </>
                )}

                {recent.length > 0 && (
                  <>
                    <div className="queue-section-label" style={{ marginTop: active.length > 0 ? 8 : 0 }}>Recent</div>
                    {recent.map(token => (
                      <TokenCard
                        key={token.id}
                        token={token}
                        selected={token.id === selectedId}
                        connName={connName(token.connection_id)}
                        onSelect={() => setSelectedId(prev => prev === token.id ? null : token.id)}
                        onApprove={() => approve(token.id)}
                        onReject={() => reject(token.id)}
                      />
                    ))}
                  </>
                )}
              </>
            )}
          </div>

          {/* Detail panel */}
          {selected && (
            <TokenDetail
              token={selected}
              connName={connName(selected.connection_id)}
              onClose={() => setSelectedId(null)}
              onApprove={() => approve(selected.id)}
              onReject={() => reject(selected.id)}
            />
          )}
        </div>
      </div>

      {/* Connection modal — null=closed, undefined=create, Connection=edit */}
      {modalConn !== null && (
        <ConnectionModal
          connection={modalConn}
          onClose={() => setModalConn(null)}
          onSaved={handleModalSaved}
        />
      )}
    </>
  )
}
