export type AgentE2eQueueItem = {
  sessionId: string;
  utteranceId: string;
  candidateText: string;
  replyText: string;
  source?: string;
};

export class AgentE2eQueue {
  private readonly items: AgentE2eQueueItem[] = [];
  private readonly keys = new Set<string>();

  enqueue(item: AgentE2eQueueItem) {
    const key = `${item.sessionId}:${item.utteranceId}`;
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    this.items.push(item);
    return true;
  }

  peek() { return this.items[0]; }

  shift() {
    const item = this.items.shift();
    if (item) this.keys.delete(`${item.sessionId}:${item.utteranceId}`);
    return item;
  }

  clear() {
    this.items.length = 0;
    this.keys.clear();
  }

  get size() { return this.items.length; }
}
