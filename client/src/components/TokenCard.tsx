import type { Token, TokenStatus } from '../types'

interface Props {
  token:      Token
  selected:   boolean
  connName:   string
  onSelect:   () => void
  onApprove:  () => void
  onReject:   () => void
  onStop:     () => void
}

function badgeClass(status: TokenStatus): string {
  switch (status) {
    case 'PENDING_APPROVAL':  return 'badge-pending'
    case 'APPROVED':          return 'badge-approved'
    case 'RUNNING':           return 'badge-running'
    case 'COMPLETED':         return 'badge-completed'
    case 'FAILED':            return 'badge-failed'
    case 'REJECTED':          return 'badge-rejected'
    case 'WAITING_FOR_INPUT': return 'badge-waiting'
    default:                  return 'badge-pending'
  }
}

function cardClass(status: TokenStatus): string {
  switch (status) {
    case 'PENDING_APPROVAL':  return 'pending'
    case 'APPROVED':
    case 'RUNNING':           return 'running'
    case 'WAITING_FOR_INPUT': return 'waiting'
    case 'COMPLETED':         return 'completed'
    case 'FAILED':
    case 'REJECTED':          return 'failed'
    default:                  return ''
  }
}

function statusLabel(status: TokenStatus): string {
  switch (status) {
    case 'PENDING_APPROVAL':  return 'PENDING'
    case 'WAITING_FOR_INPUT': return 'WAITING'
    default:                  return status
  }
}

function relativeTime(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60)    return `${diff}s ago`
  if (diff < 3600)  return `${Math.floor(diff/60)}m ago`
  return `${Math.floor(diff/3600)}h ago`
}

export function TokenCard({ token, selected, connName, onSelect, onApprove, onReject, onStop }: Props) {
  const isPending   = token.status === 'PENDING_APPROVAL'
  const isActive    = token.status === 'APPROVED' || token.status === 'RUNNING'
  const isRunning   = token.status === 'RUNNING' || token.status === 'WAITING_FOR_INPUT'
  const inputAsks   = token.input_requests.filter(r => r.status === 'PENDING').length

  return (
    <div
      className={`token-card ${cardClass(token.status)}${selected ? ' selected' : ''}`}
      onClick={onSelect}
    >
      <div className="token-card-top">
        <span className={`token-status-badge ${badgeClass(token.status)}`}>
          {isActive && <span className="spinner" style={{marginRight:5}} />}
          {statusLabel(token.status)}
        </span>
        <span className="token-description">{token.description}</span>
      </div>

      <div className="token-meta">
        <span>⬡ {connName}</span>
        <span>{token.commands.length} cmd{token.commands.length !== 1 ? 's' : ''}</span>
        <span>{relativeTime(token.created_at)}</span>
        {token.recovered && <span className="recovered-badge">reattached</span>}
      </div>

      {token.status === 'WAITING_FOR_INPUT' && token.waiting_for_input && (
        <div className="token-waiting-prompt" title={token.waiting_for_input.recent_output}>
          ⌨ {token.waiting_for_input.prompt || 'waiting for input'}
        </div>
      )}
      {inputAsks > 0 && (
        <div className="token-waiting-prompt">
          AI input awaiting approval ({inputAsks}) — open to review
        </div>
      )}

      <div className="token-commands-preview">
        {token.commands.slice(0, 3).map((cmd, i) => {
          let cls = ''
          if (cmd.completed_at && cmd.exit_code === 0) cls = 'done'
          else if (cmd.completed_at && cmd.exit_code !== 0) cls = 'failed'
          else if (cmd.executed_at && !cmd.completed_at) cls = 'active'

          return (
            <div key={i} className={`cmd-line ${cls}`}>
              <span className="prompt">$</span>
              <span className="cmd-text">{cmd.command}</span>
              {cmd.executed_at && !cmd.completed_at && <span className="spinner" />}
            </div>
          )
        })}
        {token.commands.length > 3 && (
          <div style={{fontSize:10,color:'var(--text-muted)',paddingLeft:8}}>
            +{token.commands.length - 3} more
          </div>
        )}
      </div>

      {isPending && (
        <div className="token-actions" onClick={e => e.stopPropagation()}>
          <button className="btn btn-approve" onClick={onApprove}>Approve</button>
          <button className="btn btn-reject"  onClick={onReject}>Reject</button>
        </div>
      )}

      {isRunning && (
        <div className="token-actions" onClick={e => e.stopPropagation()}>
          <button className="btn btn-stop" onClick={onStop} title="Interrupt the running command">■ Stop</button>
        </div>
      )}
    </div>
  )
}
