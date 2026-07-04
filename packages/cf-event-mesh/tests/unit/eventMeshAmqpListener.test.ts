/* eslint-disable @typescript-eslint/no-empty-function */
import EventEmitter from 'node:events';

import { describe, it, expect, vi } from 'vitest';

import { EventMeshAmqpListener } from '../../src/eventMeshAmqpListener.js';
import type { EventMeshBinding } from '../../src/eventMeshBindings.js';

const mockBinding: EventMeshBinding = {
  index: 0,
  name: 'test',
  instanceName: 'test',
  namespace: 'ns',
  management: { uri: 'mock', oa2: { clientid: 'c', clientsecret: 's', tokenendpoint: 'https://token' } },
  messaging: { uri: 'https://msg', oa2: { clientid: 'c', clientsecret: 's', tokenendpoint: 'https://token' } },
  amqp: { uri: 'wss://amqp', oa2: { clientid: 'c', clientsecret: 's', tokenendpoint: 'https://token' } },
};

class MockStream extends EventEmitter {
  receiver() {
    return { detach: vi.fn() };
  }
}

class MockClient extends EventEmitter {
  connect() {
    setTimeout(() => {
      this.emit('connected', {}, { description: 'mock server' });
    }, 5);
  }
  disconnect() {}
  receiver() {
    return {
      attach: () => {
        const stream = new MockStream();
        setTimeout(() => stream.emit('subscribed'), 10);
        return stream;
      }
    };
  }
}

describe('EventMeshAmqpListener', () => {
  it('should start successfully', async () => {
    const callbacks = { onMessage: vi.fn(), onError: vi.fn(), onConnected: vi.fn() };
    const listener = new EventMeshAmqpListener(mockBinding, 'q1', callbacks, { Client: MockClient as unknown } as never);
    await listener.start();
    expect(callbacks.onConnected).toHaveBeenCalledWith('mock server');
    listener.stop();
  });

  it('should handle startup timeout', async () => {
    class SlowClient extends EventEmitter {
      connect() {} // Never connects
      disconnect() {}
      receiver() { return { attach: () => new MockStream() }; }
    }
    const callbacks = { onMessage: vi.fn(), onError: vi.fn(), onConnected: vi.fn() };
    const listener = new EventMeshAmqpListener(mockBinding, 'q1', callbacks, { Client: SlowClient as unknown } as never, { startupTimeoutMs: 50 });
    await expect(listener.start()).rejects.toThrow('Event Mesh AMQP subscription timed out');
  });

  it('should handle client error', async () => {
    class ErrorClient extends EventEmitter {
      connect() { setTimeout(() => this.emit('error', new Error('client failure')), 5); }
      disconnect() {}
      receiver() { return { attach: () => new MockStream() }; }
    }
    const callbacks = { onMessage: vi.fn(), onError: vi.fn(), onConnected: vi.fn() };
    const listener = new EventMeshAmqpListener(mockBinding, 'q1', callbacks, { Client: ErrorClient as unknown } as never);
    
    await expect(listener.start()).rejects.toThrow('client failure');
  });

  it('should normalize and handle messages', async () => {
    let capturedStream: MockStream;
    class MsgClient extends EventEmitter {
      connect() { setTimeout(() => this.emit('connected', {}, {}), 2); }
      disconnect() {}
      receiver() {
        return {
          attach: () => {
            capturedStream = new MockStream();
            setTimeout(() => capturedStream.emit('subscribed'), 4);
            return capturedStream;
          }
        };
      }
    }
    
    const callbacks = { onMessage: vi.fn(), onError: vi.fn(), onConnected: vi.fn() };
    const listener = new EventMeshAmqpListener(mockBinding, 'q1', callbacks, { Client: MsgClient as unknown } as never, { autoAck: true });
    await listener.start();
    
    const doneCb = vi.fn();
    // Simulate data event
    capturedStream!.emit('data', {
      source: { to: 'test-topic', properties: { messageId: '123' } },
      payload: { type: 'application/json', data: { hello: 'world' } },
      done: doneCb
    });
    
    expect(callbacks.onMessage).toHaveBeenCalled();
    const msg = callbacks.onMessage.mock.calls[0]?.[0];
    expect(msg.topic).toBe('test-topic');
    expect(msg.messageId).toBe('123');
    expect(msg.contentType).toBe('application/json');
    expect(msg.body.toString()).toBe('{"hello":"world"}');
    expect(doneCb).toHaveBeenCalled();
    
    // Test chunked buffer payload
    capturedStream!.emit('data', {
      source: { deliveryTag: '456' },
      payload: { chunks: [Buffer.from('hello')] },
      done: doneCb
    });
    
    const msg2 = callbacks.onMessage.mock.calls[1]?.[0];
    expect(msg2.messageId).toBe('456');
    expect(msg2.body.toString()).toBe('hello');

    // Test stream error
    capturedStream!.emit('error', new Error('stream error'));
    expect(callbacks.onError).toHaveBeenCalledWith('stream error: stream error');
    
    // Test done throwing error
    const throwDone = vi.fn(() => { throw new Error('fail done'); });
    capturedStream!.emit('data', {
      source: { deliveryTag: '789' },
      payload: { chunks: [Buffer.from('hello')] },
      done: throwDone
    });
    // Should swallow error
    expect(throwDone).toHaveBeenCalled();

    listener.stop();
  });

  it('should ignore detach and disconnect errors', async () => {
    class ThrowStream extends EventEmitter {
      constructor() {
        super();
        setTimeout(() => this.emit('subscribed'), 5);
      }
      receiver() { return { detach: () => { throw new Error('detach fail'); } }; }
    }
    class ThrowClient extends EventEmitter {
      connect() { setTimeout(() => this.emit('connected', {}, {}), 2); }
      disconnect() { throw new Error('disconnect fail'); }
      receiver() {
        return { attach: () => new ThrowStream() };
      }
    }
    
    const callbacks = { onMessage: vi.fn(), onError: vi.fn(), onConnected: vi.fn() };
    const listener = new EventMeshAmqpListener(mockBinding, 'q1', callbacks, { Client: ThrowClient as unknown } as never);
    await listener.start();
    
    // Should not throw
    listener.stop();
  });
});
