import type { ClientChannel } from 'ssh2';
import { config } from '../config.js';
import type { RemoteRun, RemoteRunInfo } from '../queue/types.js';
import { normalizeOutput } from './output-buffer.js';
import { FALLBACK_BASE_WORD, isRunName, remoteBaseWord, runDirName, sq } from './shell-protocol.js';
import type { ShellSession } from './shell-session.js';

// Helper scripts run on side channels against a run directory or process tree,
// each next to the parsing of its output.

export type Signal = 'INT' | 'TERM' | 'KILL';

// Shell function printing every descendant pid of $1 (not $1 itself).
// Uses ps where available, falling back to /proc for minimal systems.
const DESCENDANTS_FN = `vigil_desc() {
  { ps -e -o pid= -o ppid= 2>/dev/null || for f in /proc/[0-9]*/status; do awk '/^Pid:/{p=$2} /^PPid:/{q=$2} END{if(p!="")print p, q}' "$f" 2>/dev/null; done; } |
  awk -v root="$1" '{ par[$1]=$2 } END { m[root]=1; do { f=0; for (p in par) if (!(p in m) && (par[p] in m)) { m[p]=1; f=1 } } while (f); for (p in m) if (p != root) print p }'
}`;

// ─── Run state ────────────────────────────────────────────────────────────────

export interface RunDirState {
  state:      'missing' | 'exited' | 'alive' | 'dead';
  exit_code?: number;
  size:       number;   // bytes in `out`
}

export async function inspectRun(session: ShellSession, remote: RemoteRun): Promise<RunDirState> {
  const res = await session.exec([
    `d=${sq(remote.dir)}`,
    `[ -d "$d" ] || { echo MISSING; exit 0; }`,
    `sz=$(wc -c < "$d/out" 2>/dev/null || echo 0)`,
    `if [ -f "$d/exit" ]; then echo "EXITED:$(cat "$d/exit"):$sz"; exit 0; fi`,
    `if kill -0 ${remote.shell_pid} 2>/dev/null; then echo "ALIVE:0:$sz"; else echo "DEAD:0:$sz"; fi`,
  ].join('\n'), { timeoutMs: 15000 });

  const line = res.stdout.toString('utf8').trim();
  if (line === 'MISSING') return { state: 'missing', size: 0 };

  const match = line.match(/^(EXITED|ALIVE|DEAD):(-?\d*):\s*(\d+)/);
  if (!match) throw new Error(`[ssh] unexpected run inspection output: ${JSON.stringify(line)}`);

  const size = parseInt(match[3], 10);
  if (match[1] === 'EXITED') return { state: 'exited', exit_code: parseInt(match[2], 10), size };
  return { state: match[1] === 'ALIVE' ? 'alive' : 'dead', size };
}

// ─── Signals ──────────────────────────────────────────────────────────────────

// Signal every descendant of `root`. With `interruptRoot`, the shell itself gets
// SIGINT first, so its run trap is pending before the children die.
export async function signalTree(
  session: ShellSession,
  root: number,
  sig: Signal,
  opts: { interruptRoot: boolean; extra?: number[] },
): Promise<void> {
  const extra = opts.extra ?? [];
  await session.exec([
    DESCENDANTS_FN,
    opts.interruptRoot ? `kill -s INT ${root} 2>/dev/null` : '',
    `for p in $(vigil_desc ${root}); do kill -s ${sig} "$p" 2>/dev/null; done`,
    extra.length ? `kill -s ${sig} ${extra.join(' ')} 2>/dev/null` : '',
    'exit 0',
  ].join('\n'), { timeoutMs: 15000 });
}

// ─── Stdin ────────────────────────────────────────────────────────────────────

export type StdinState = 'WAITING' | 'BUSY' | 'UNKNOWN';

// Is any process in the command's tree (or the shell itself, for builtins like
// `read`) blocked reading the run's stdin FIFO? UNKNOWN when /proc can't tell.
export async function probeStdin(session: ShellSession, remote: RemoteRun): Promise<StdinState> {
  const name = runDirName(remote.dir);

  const res = await session.exec([
    DESCENDANTS_FN,
    `found=0; known=0`,
    `for p in ${remote.shell_pid} $(vigil_desc ${remote.shell_pid}); do`,
    `  l=$(readlink /proc/$p/fd/0 2>/dev/null) || continue`,
    `  case "$l" in */${name}/in*) ;; *) continue;; esac`,
    `  found=1`,
    `  w=$(cat /proc/$p/wchan 2>/dev/null); s=$(cut -d' ' -f1,2 /proc/$p/syscall 2>/dev/null)`,
    `  case "$w" in *pipe_read*|*pipe_wait*) echo WAITING; exit 0;; esac`,
    // read(0, …): syscall 0 on x86_64, 63 on aarch64
    `  case "$s" in "0 0x0"|"63 0x0") echo WAITING; exit 0;; esac`,
    `  if [ -n "$w" ] && [ "$w" != 0 ]; then known=1; fi`,
    `  case "$s" in ""|running*) ;; *) known=1;; esac`,
    `done`,
    `if [ $found = 1 ] && [ $known = 1 ]; then echo BUSY; else echo UNKNOWN; fi`,
  ].join('\n'), { timeoutMs: 10000 });

  const out = res.stdout.toString('utf8').trim();
  return out === 'WAITING' || out === 'BUSY' ? out : 'UNKNOWN';
}

// Input goes to the command's own FIFO through a separate channel — never into
// the shell's stdin, so it can't be executed as a shell command.
//
// The input is read in full first and written with a single printf (atomic for
// pipe writes up to 4KB) with SIGPIPE ignored, so the exit status says exactly
// whether it reached the pipe. Streaming it with `cat` could report SIGPIPE
// (141) after the command had already read the input and exited. The helper
// must not `exec` its last command either: OpenSSH then closes the channel
// before the exit status is sent.
export async function writeStdin(session: ShellSession, remote: RemoteRun, data: string): Promise<void> {
  const res = await session.exec([
    `f=${sq(remote.dir + '/in')}`,
    `[ -p "$f" ] || exit 3`,
    `data=$(cat; printf x); data=\${data%x}`,
    `trap '' PIPE`,
    `printf '%s' "$data" > "$f" || exit 4`,
    `exit 0`,
  ].join('\n'), { stdin: data, timeoutMs: 10000 });

  if (res.code === 3) throw new Error('the command has already finished');
  if (res.code === 4) throw new Error('the command closed its input before reading it');
  if (res.code !== 0) {
    const reason = res.stderr.trim() || (res.signal ? `killed by ${res.signal}` : `exit ${res.code ?? 'status not reported'}`);
    throw new Error(`failed to write input: ${reason}`);
  }
}

// Readers see EOF once the last writer (the holder) is gone.
export async function closeStdin(session: ShellSession, remote: RemoteRun): Promise<void> {
  await session.exec(`kill -9 ${remote.holder_pid} 2>/dev/null; exit 0`, { timeoutMs: 10000 });
}

// ─── Output ───────────────────────────────────────────────────────────────────

// Follows `out` from `fromByte` (1-based). The remote loop exits by itself once
// the command has finished (or its shell is gone), so tails never leak.
export function tailOutput(session: ShellSession, remote: RemoteRun, fromByte: number): Promise<ClientChannel> {
  return session.openChannel([
    `f=${sq(remote.dir)}`,
    `tail -c +${fromByte} -f "$f/out" 2>/dev/null & t=$!`,
    `while [ ! -f "$f/exit" ] && kill -0 ${remote.shell_pid} 2>/dev/null; do sleep 1; done`,
    `sleep 1; kill $t 2>/dev/null; wait $t 2>/dev/null; exit 0`,
  ].join('\n'));
}

// Raw bytes of `out` from `fromByte` (1-based), capped to the output limit.
export async function readOutputFrom(session: ShellSession, dir: string, fromByte: number): Promise<Buffer> {
  const res = await session.exec(
    `tail -c +${fromByte} ${sq(dir + '/out')} 2>/dev/null | tail -c ${config.outputMaxBytes}; exit 0`,
    { timeoutMs: 30000 },
  );
  return res.stdout;
}

// The tail of `out`, normalised.
export async function readOutput(session: ShellSession, dir: string): Promise<string> {
  const res = await session.exec(
    `tail -c ${config.outputMaxBytes} ${sq(dir + '/out')} 2>/dev/null; exit 0`,
    { timeoutMs: 30000 },
  );
  return normalizeOutput(res.stdout.toString('utf8'));
}

// ─── Run directories ──────────────────────────────────────────────────────────

// Kill a leftover FIFO holder (e.g. after a session reset) — only if the pid
// still points at this run's FIFO — then delete known files rather than rm -rf.
export async function removeRunDir(session: ShellSession, dir: string): Promise<void> {
  const name = runDirName(dir);
  await session.exec([
    `d=${sq(dir)}`,
    `h=$(cat "$d/holder" 2>/dev/null)`,
    `[ -n "$h" ] && case "$(readlink /proc/$h/fd/1 2>/dev/null)" in */${name}/in*) kill -9 "$h" 2>/dev/null;; esac`,
    `rm -f "$d/in" "$d/out" "$d/exit" "$d/holder" "$d/shell" "$d/started" && rmdir "$d" 2>/dev/null`,
    'exit 0',
  ].join('\n'), { timeoutMs: 15000 });
}

export async function listRunDirs(session: ShellSession): Promise<RemoteRunInfo[]> {
  const res = await session.exec([
    `for b in ${remoteBaseWord()} ${FALLBACK_BASE_WORD}; do`,
    `  [ -d "$b" ] || continue`,
    `  for d in "$b"/*; do`,
    `    [ -f "$d/shell" ] || continue`,
    `    sh=$(cat "$d/shell" 2>/dev/null); ho=$(cat "$d/holder" 2>/dev/null); st=$(cat "$d/started" 2>/dev/null)`,
    `    if [ -f "$d/exit" ]; then s="exited:$(cat "$d/exit")"`,
    `    elif [ -n "$sh" ] && kill -0 "$sh" 2>/dev/null; then s="alive:"`,
    `    else s="dead:"; fi`,
    `    printf '%s|%s|%s|%s|%s\\n' "$d" "$s" "$sh" "$ho" "$st"`,
    `  done`,
    `done`,
    'exit 0',
  ].join('\n'), { timeoutMs: 30000 });

  const infos: RemoteRunInfo[] = [];
  for (const line of res.stdout.toString('utf8').split('\n')) {
    const [dir, status, shell, holder, started] = line.split('|');
    if (!dir || !status) continue;
    const name = runDirName(dir);
    if (!isRunName(name)) continue;

    const [state, code] = status.split(':');
    infos.push({
      name,
      dir,
      state:      state === 'exited' ? 'exited' : state === 'alive' ? 'alive' : 'dead',
      exit_code:  state === 'exited' && code !== '' ? parseInt(code, 10) : undefined,
      shell_pid:  shell  ? parseInt(shell, 10)  : undefined,
      holder_pid: holder ? parseInt(holder, 10) : undefined,
      started_at: started || undefined,
    });
  }
  return infos;
}
