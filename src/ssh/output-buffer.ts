import { StringDecoder } from 'string_decoder';

// Output of one command: keeps the last `maxChars`, decodes UTF-8 across chunk
// boundaries, and tracks how many bytes of the remote log have been consumed.
export class OutputBuffer {
  private text      = '';
  private truncated = false;
  private readonly decoder = new StringDecoder('utf8');

  // Bytes of the run's `out` file consumed so far.
  bytes = 0;

  constructor(private readonly maxChars: number) {}

  // Start following a log part-way through; earlier bytes are skipped.
  startAt(byteOffset: number): void {
    this.bytes     = byteOffset;
    this.truncated = byteOffset > 0;
  }

  // Add raw log bytes. Returns the text added.
  pushBytes(chunk: Buffer, final = false): string {
    this.bytes += chunk.length;
    const text = this.decoder.write(chunk) + (final ? this.decoder.end() : '');
    this.pushText(text);
    return text;
  }

  pushText(text: string): void {
    if (!text) return;
    this.text += text;
    if (this.text.length > this.maxChars) {
      this.text      = this.text.slice(-this.maxChars);
      this.truncated = true;
    }
  }

  // A trailing partial line often means a prompt.
  get endsMidLine(): boolean {
    return this.text.length > 0 && !this.text.endsWith('\n');
  }

  final(): string {
    return normalizeOutput((this.truncated ? '[… earlier output truncated …]\n' : '') + this.text);
  }

  waitingInfo(): { prompt: string; recent_output: string } {
    const lines  = stripAnsi(this.text).replace(/\r\n?/g, '\n').split('\n');
    const prompt = [...lines].reverse().find((l) => l.trim() !== '') ?? '';
    return {
      prompt:        prompt.trimEnd().slice(-500),
      recent_output: lines.slice(-20).join('\n').slice(-4000),
    };
  }
}

export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

export function normalizeOutput(raw: string): string {
  return stripAnsi(raw)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}
