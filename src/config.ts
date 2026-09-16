// Runtime configuration from the environment.
// Read lazily: ESM imports are evaluated before dotenv.config() runs in index.ts.

function envInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

export const config = {
  // Fallback per-command timeout; 0 = none.
  get cmdTimeoutMs()        { return envInt('CMD_TIMEOUT_MS', 0); },
  // Grace period between SIGINT → SIGTERM → SIGKILL.
  get interruptGraceMs()    { return envInt('INTERRUPT_GRACE_MS', 5000); },
  // Idle time without output before probing for a stdin prompt.
  get inputIdleMs()         { return envInt('INPUT_IDLE_MS', 3000); },
  // Output kept per command (tail).
  get outputMaxBytes()      { return envInt('OUTPUT_MAX_BYTES', 2 * 1024 * 1024); },
  // How long to keep trying to reattach to a run.
  get recoveryTimeoutMs()   { return envInt('RECOVERY_TIMEOUT_MS', 5 * 60 * 1000); },
  get sshKeepaliveMs()      { return envInt('SSH_KEEPALIVE_INTERVAL_MS', 15000); },
  get sshKeepaliveCountMax(){ return envInt('SSH_KEEPALIVE_COUNT_MAX', 4); },
  get sshReadyTimeoutMs()   { return envInt('SSH_READY_TIMEOUT_MS', 20000); },
  // Run directory base on the remote host; $HOME etc. expand remotely.
  get remoteDir()           { return process.env.VIGIL_REMOTE_DIR?.trim() || '$HOME/.vigil/runs'; },
  get debugSsh()            { return process.env.DEBUG_SSH === 'true'; },
};
