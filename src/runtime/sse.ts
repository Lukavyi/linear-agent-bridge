/**
 * Minimal incremental Server-Sent Events decoder.
 *
 * Hermes' `/v1/responses` streaming endpoint emits SSE: events separated by a
 * blank line, each a set of `field: value` lines (`event`, `data`, plus `id` /
 * `retry` we ignore). `data` may span multiple lines, joined with `\n`. Network
 * chunks split events arbitrarily, so this buffers partial input across `push`
 * calls and only surfaces complete events.
 *
 * Kept as a tiny stateful class with `push(chunk)` / `flush()` so it can be
 * table-tested without a socket — feed it any chunking and assert the events.
 */

export interface SseEvent {
  /** The `event:` field, or `"message"` when omitted (per the SSE spec). */
  event: string;
  /** The joined `data:` payload (may be empty). */
  data: string;
}

export class SseDecoder {
  private buffer = "";

  /** Feed a raw chunk; returns every event completed by it. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];

    // Events are delimited by a blank line. Normalize CRLF to LF first.
    let index: number;
    this.buffer = this.buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    while ((index = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      const event = parseBlock(block);
      if (event) events.push(event);
    }
    return events;
  }

  /** Decode any trailing event not terminated by a blank line. */
  flush(): SseEvent[] {
    const block = this.buffer.trim();
    this.buffer = "";
    const event = parseBlock(block);
    return event ? [event] : [];
  }
}

function parseBlock(block: string): SseEvent | null {
  if (!block.trim()) return null;
  let event = "message";
  const data: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\n$/, "");
    if (!line || line.startsWith(":")) continue; // blank or comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value || "message";
    else if (field === "data") data.push(value);
  }
  if (data.length === 0 && event === "message") return null;
  return { event, data: data.join("\n") };
}
