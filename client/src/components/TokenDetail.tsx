import { useEffect, useRef, useState } from 'react'
import type { Command, InputPayload, Token } from '../types'

interface Props {
  token:         Token
  connName:      string
  onClose:       () => void
  onApprove:     () => void
  onReject:      () => void
  onStop:        () => void
  onSendInput:   (input: InputPayload) => Promise<string | null>
  onApproveInput:(requestId: string) => void
  onRejectInput: (requestId: string) => void
}

function elapsed(fromIso: string, toIso?: string): string {
  const secs = Math.max(0, Math.floor(((toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime()) / 1000))
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`
}

// Re-render every second while something is running, for elapsed timers.
function useTicker(active: boolean) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [active])
}

function CommandOutput({ cmd, live }: { cmd: Command; live: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Follow the output while it grows, unless the operator scrolled up.
  useEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [cmd.output])

  const onScroll = () => {
    const el = ref.current
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  const isDone = cmd.completed_at !== undefined
  if (!cmd.output && !isDone && !live) return null

  return (
    <div ref={ref} onScroll={onScroll}
      className={`detail-cmd-output${!cmd.output ? ' empty' : ''}${live ? ' live' : ''}`}>
      {cmd.output || (isDone ? 'no output' : 'waiting for output…')}
    </div>
  )
}

function InputPanel({ token, onSendInput }: { token: Token; onSendInput: Props['onSendInput'] }) {
  const [data,    setData]    = useState('')
  const [secret,  setSecret]  = useState(false)
  const [sending, setSending] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const waiting = token.waiting_for_input

  const send = async (eof: boolean) => {
    setSending(true)
    setError(null)
    const err = await onSendInput({ data: eof ? '' : data, newline: !eof, eof, secret })
    setSending(false)
    if (err) setError(err)
    else if (!eof) setData('')
  }

  return (
    <div className={`input-panel${waiting ? ' waiting' : ''}`}>
      <div className="input-panel-label">
        {waiting ? 'Waiting for input' : 'Send input'}
      </div>
      {waiting && (
        <div className="input-panel-prompt">{waiting.prompt || '(no prompt text)'}</div>
      )}
      <div className="input-panel-row">
        <input
          className="form-input input-panel-field"
          type={secret ? 'password' : 'text'}
          value={data}
          placeholder={waiting ? 'Type a response…' : 'stdin for the running command'}
          onChange={e => setData(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !sending) void send(false) }}
          disabled={sending}
        />
        <button className="btn btn-primary" onClick={() => send(false)} disabled={sending}>Send</button>
        <button className="btn btn-ghost" onClick={() => send(true)} disabled={sending} title="Close stdin (Ctrl+D)">EOF</button>
      </div>
      <label className="input-panel-secret">
        <input type="checkbox" checked={secret} onChange={e => setSecret(e.target.checked)} />
        Secret (masked, not logged)
      </label>
      {error && <div className="form-error">{error}</div>}
    </div>
  )
}

export function TokenDetail({
  token, connName, onClose, onApprove, onReject, onStop, onSendInput, onApproveInput, onRejectInput,
}: Props) {
  const isPending = token.status === 'PENDING_APPROVAL'
  const isRunning = token.status === 'RUNNING' || token.status === 'WAITING_FOR_INPUT'
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const stopping = isRunning && stoppingId === token.id

  useTicker(isRunning)

  const pendingInput = token.input_requests.filter(r => r.status === 'PENDING')
  const inputHistory = token.input_requests.filter(r => r.status !== 'PENDING')

  const stop = () => {
    setStoppingId(token.id)
    onStop()
  }

  return (
    <aside className="detail">
      <div className="detail-header">
        <div className="detail-title">
          <div style={{fontSize:11,color:'var(--text-muted)',marginBottom:4}}>
            {connName}
            {token.recovered && <span className="recovered-badge" title="Vigil reattached to this command after a restart or dropped connection">reattached</span>}
          </div>
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

        {isRunning && (
          <button className="btn btn-stop" onClick={stop} disabled={stopping}
            title="Interrupt the running command (SIGINT, then SIGTERM, then SIGKILL)">
            {stopping ? 'Stopping…' : '■ Stop'}
          </button>
        )}

        {/* AI input awaiting approval */}
        {pendingInput.map(req => (
          <div key={req.id} className="input-request">
            <div className="input-panel-label">AI wants to send input</div>
            <div className="input-request-data">
              {req.data !== '' ? req.data : <em>(empty)</em>}
              {req.newline && !(req.eof && req.data === '') && <span className="input-request-flag">⏎</span>}
              {req.eof && <span className="input-request-flag">EOF</span>}
            </div>
            <div style={{display:'flex',gap:8,marginTop:8}}>
              <button className="btn btn-approve" style={{flex:1}} onClick={() => onApproveInput(req.id)}>Approve</button>
              <button className="btn btn-reject"  style={{flex:1}} onClick={() => onRejectInput(req.id)}>Reject</button>
            </div>
          </div>
        ))}

        {/* Operator input */}
        {isRunning && <InputPanel token={token} onSendInput={onSendInput} />}

        {/* Error */}
        {token.error && (
          <div className="detail-error">
            <div className="detail-error-label">
              {token.error.reason}
              {token.error.stopped_by && ` · by ${token.error.stopped_by === 'HUMAN' ? 'operator' : token.error.stopped_by === 'AI' ? 'AI' : 'timeout'}`}
            </div>
            {token.error.human_note  && <div>{token.error.human_note}</div>}
            {token.error.note        && <div style={{fontSize:11,marginTop:4}}>{token.error.note}</div>}
            {token.error.session_reset && <div style={{fontSize:11,marginTop:4}}>SSH session was reset to stop the command.</div>}
            {token.error.command     && <div style={{fontFamily:'var(--font-mono)',fontSize:11,marginTop:4}}>$ {token.error.command}</div>}
            {token.error.stderr      && <div style={{fontFamily:'var(--font-mono)',fontSize:11,opacity:0.8,marginTop:4}}>{token.error.stderr}</div>}
            {token.error.exit_code !== undefined && (
              <div style={{fontSize:11,marginTop:4}}>exit {token.error.exit_code}</div>
            )}
          </div>
        )}

        {/* Commands */}
        {token.commands.map((cmd, i) => {
          const isDone     = cmd.completed_at !== undefined
          const isCmdLive  = isRunning && Boolean(cmd.executed_at) && !isDone
          const exitOk     = cmd.exit_code === 0

          return (
            <div key={i} className="detail-cmd-block">
              <div className="detail-cmd-header">
                <span className="detail-cmd-index">{i + 1}</span>
                <span className="detail-cmd-text" title={cmd.command}>{cmd.command}</span>
                {cmd.executed_at && (isCmdLive || isDone) && (
                  <span className="detail-cmd-elapsed">{elapsed(cmd.executed_at, cmd.completed_at)}</span>
                )}
                {isCmdLive && <span className="spinner" />}
                {isDone && (
                  <span className={`detail-exit-code ${exitOk ? 'exit-ok' : 'exit-fail'}`}>
                    {exitOk ? '✓ 0' : `✗ ${cmd.exit_code}`}
                  </span>
                )}
              </div>
              <CommandOutput cmd={cmd} live={isCmdLive} />
            </div>
          )
        })}

        {/* Input history */}
        {inputHistory.length > 0 && (
          <div className="detail-mutations">
            <div className="detail-mutations-label">Input</div>
            {inputHistory.map(r => (
              <div key={r.id} className="mutation-row">
                <div className="mutation-cmd">
                  {r.source === 'AI' ? 'AI' : 'Operator'} → cmd {r.command_index + 1}: {r.data !== '' ? r.data : '(empty)'}{r.eof ? ' <EOF>' : ''}
                </div>
                <div style={{fontSize:10,color:'var(--text-dim)',marginTop:2}}>
                  {r.status}{r.error ? ` — ${r.error}` : ''}
                </div>
              </div>
            ))}
          </div>
        )}

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
