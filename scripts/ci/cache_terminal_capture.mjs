// Capture host-routed terminal output without changing guest acknowledgements.
// Keep a bounded tail: a stuck guest must not exhaust host memory with logs.
export function createCacheTerminalCapture(limit = 65536) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('invalid terminal capture limit');
  let tail = '';
  let messages = 0;
  let bytes = 0;
  const decoders = new Map();
  return {
    push(args) {
      if (!args || !Number.isInteger(args.session_id) || !Array.isArray(args.data)
        || args.data.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
        throw new Error('invalid cache terminalWrite payload');
      }
      // Bound decoder state even for malformed/unexpected session proliferation.
      const id = args.session_id >>> 0;
      if (!decoders.has(id)) {
        if (decoders.size >= 16) throw new Error('too many cache terminal sessions');
        decoders.set(id, new TextDecoder());
      }
      messages++;
      bytes += args.data.length;
      const text = decoders.get(id).decode(Uint8Array.from(args.data), {stream: true});
      tail = (tail + `[session=${id}] ${text}`).slice(-limit);
    },
    snapshot() { return {messages, bytes, tail}; },
  };
}
