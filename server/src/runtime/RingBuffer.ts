export class RingBuffer {
  private chunks: string[] = [];
  private size = 0;

  constructor(private readonly capacity: number) {}

  push(s: string): void {
    if (s.length === 0) return;
    this.chunks.push(s);
    this.size += s.length;
    while (this.size > this.capacity) {
      const head = this.chunks[0]!;
      const overshoot = this.size - this.capacity;
      if (head.length <= overshoot) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.slice(overshoot);
        this.size -= overshoot;
      }
    }
  }

  snapshot(): string {
    return this.chunks.join('');
  }
}
