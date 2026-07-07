import type { Token } from '../types'

interface Props {
  token:     Token
  connName:  string
  onClose:   () => void
  onApprove: () => void
  onReject:  () => void
}

export function TokenDetail({ token, connName, onClose, onApprove, onReject }: Props) {
  const isPending = token.status === 'PENDING_APPROVAL'

  return (
    <aside className="detail">
      <div className="detail-header">
        <div className="detail-title">
          <div style={{fontSize:11,color:'var(--text-muted)',marginBottom:4}}>{connName}</div>
          {token.description}
        </div>
        <button className="detail-close" onClick={onClose}>✕</button>
      </div>

      <div className="detail-scroll">

        {/* Actions */}
        {isPending && (
          <div style={{display:'flex',gap:8}}>
            <button className="btn btn-approve" style={{flex:1}} onClick={onApprove}>Approve</button>
            <button className="btn btn-reject"  style={{flex:1}} onClick={onReject}>Reject</button>
          </div>
        )}

        {/* Error */}
        {token.error && (
          <div className="detail-error">
            <div className="detail-error-label">{token.error.reason}</div>
            {token.error.human_note  && <div>{token.error.human_note}</div>}
            {token.error.command     && <div style={{fontFamily:'var(--font-mono)',fontSize:11,marginTop:4}}>$ {token.error.command}</div>}
            {token.error.stderr      && <div style={{fontFamily:'var(--font-mono)',fontSize:11,opacity:0.8,marginTop:4}}>{token.error.stderr}</div>}
            {token.error.exit_code !== undefined && (
              <div style={{fontSize:11,marginTop:4}}>exit {token.error.exit_code}</div>
            )}
          </div>
        )}

        {/* Commands */}
        {token.commands.map((cmd, i) => {
          const isDone    = cmd.completed_at !== undefined
          const isRunning = cmd.executed_at && !cmd.completed_at
          const exitOk    = cmd.exit_code === 0

          return (
            <div key={i} className="detail-cmd-block">
              <div className="detail-cmd-header">
                <span className="detail-cmd-index">{i + 1}</span>
                <span className="detail-cmd-text">{cmd.command}</span>
                {isRunning && <span className="spinner" />}
                {isDone && (
                  <span className={`detail-exit-code ${exitOk ? 'exit-ok' : 'exit-fail'}`}>
                    {exitOk ? '✓ 0' : `✗ ${cmd.exit_code}`}
                  </span>
                )}
              </div>
              {(cmd.output || isDone) && (
                <div className={`detail-cmd-output${!cmd.output ? ' empty' : ''}`}>
                  {cmd.output || 'no output'}
                </div>
              )}
            </div>
          )
        })}

        {/* Human mutations */}
        {token.session_mutations.length > 0 && (
          <div className="detail-mutations">
            <div className="detail-mutations-label">Human injected</div>
            {token.session_mutations.map(m => (
              <div key={m.id} className="mutation-row">
                <div className="mutation-cmd">$ {m.command}</div>
                {m.output && (
                  <div style={{fontSize:10,color:'var(--text-dim)',marginTop:2,fontFamily:'var(--font-mono)'}}>{m.output}</div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Token ID */}
        <div style={{fontSize:10,color:'var(--text-muted)',fontFamily:'var(--font-mono)',marginTop:4}}>
          {token.id}
        </div>

      </div>
    </aside>
  )
}
