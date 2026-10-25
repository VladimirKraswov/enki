/** A frame above the decoder bound; `id` is its SSE id when it was announced first. */
export class SseFrameTooLarge extends Error {
  constructor(readonly id: string | null) {
    super('Event stream frame exceeds the size limit');
    this.name = 'SseFrameTooLarge';
  }
}

/** Incremental SSE framing; a bound applies to one event, not a network chunk. */
export class SseDecoder {
  private line = '';
  private data: string[] = [];
  private id: string | null = null;
  private size = 0;
  private skipLF = false;

  constructor(private readonly maxFrameCharacters = 4_000_000) {}

  /** Returning false from consume stops processing the rest of this chunk. */
  push(text: string, consume: (data: string, id: string | null) => boolean): void {
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (this.skipLF) {
        this.skipLF = false;
        if (char === '\n') { start = i + 1; continue; }
      }
      if (char !== '\r' && char !== '\n') continue;
      this.append(text.slice(start, i));
      const line = this.line;
      this.line = '';
      this.skipLF = char === '\r';
      start = i + 1;
      if (!line) {
        const data = this.data.join('\n'), id = this.id;
        this.data = [];
        this.id = null;
        this.size = 0;
        if (data && !consume(data, id)) return;
      } else if (line.startsWith('data:')) {
        this.data.push(line.slice(5).replace(/^ /, ''));
      } else if (line.startsWith('id:')) {
        this.id = line.slice(3).replace(/^ /, '');
      }
    }
    this.append(text.slice(start));
  }

  private append(text: string) {
    this.size += text.length;
    if (this.size > this.maxFrameCharacters) {
      // The id line (if any) precedes data, so an oversized frame still names its seq.
      const id = this.id;
      this.line = ''; this.data = []; this.id = null; this.size = 0;
      throw new SseFrameTooLarge(id);
    }
    this.line += text;
  }
}
