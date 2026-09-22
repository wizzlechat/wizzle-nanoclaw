// Minimal socket abstraction so tests can run the client against an in-process relay.
export type TransportHandlers = {
  onOpen(): void;
  onText(text: string): void;
  onBinary(bytes: Uint8Array): void;
  onClose(code: number, reason: string): void;
};

export interface TransportConn {
  sendText(text: string): void;
  sendBinary(bytes: Uint8Array): void;
  close(): void;
}

export interface Transport {
  connect(url: string, handlers: TransportHandlers): TransportConn;
}

// Node 22 ships a global WebSocket, so the bridge needs no socket dependency.
export const webSocketTransport: Transport = {
  connect(url, handlers) {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    let closed = false;
    ws.addEventListener('open', () => handlers.onOpen());
    ws.addEventListener('message', (event) => {
      const data: unknown = event.data;
      if (typeof data === 'string') handlers.onText(data);
      else if (data instanceof ArrayBuffer) handlers.onBinary(new Uint8Array(data));
    });
    ws.addEventListener('close', (event) => {
      if (closed) return;
      closed = true;
      handlers.onClose(event.code, event.reason);
    });
    // A failed connect raises error and then close; close carries the report.
    ws.addEventListener('error', () => undefined);
    return {
      sendText: (text) => ws.send(text),
      sendBinary: (bytes) => ws.send(bytes),
      close: () => ws.close(),
    };
  },
};
