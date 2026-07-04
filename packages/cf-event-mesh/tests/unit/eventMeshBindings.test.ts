import { describe, it, expect } from 'vitest';

import { extractEventMeshBindings } from '../../src/eventMeshBindings.js';

describe('eventMeshBindings', () => {
  it('should return empty array for invalid input', () => {
    expect(extractEventMeshBindings(null)).toEqual([]);
    expect(extractEventMeshBindings({})).toEqual([]);
    expect(extractEventMeshBindings({ 'VCAP_SERVICES': {} })).toEqual([]);
  });

  it('should extract valid bindings', () => {
    const vcap = {
      'enterprise-messaging': [
        {
          name: 'test-em',
          credentials: {
            namespace: 'test-ns',
            management: [
              {
                uri: 'https://manage.example.com',
                oa2: {
                  clientid: 'm-client',
                  clientsecret: 'm-secret',
                  tokenendpoint: 'https://m-token.example.com'
                }
              }
            ],
            messaging: [
              {
                protocol: ['httprest'],
                uri: 'https://msg.example.com',
                oa2: {
                  clientid: 'c1',
                  clientsecret: 's1',
                  tokenendpoint: 'https://t1.example.com',
                  granttype: 'client_credentials'
                }
              },
              {
                protocol: ['amqp10ws'],
                uri: 'wss://amqp.example.com',
                oa2: {
                  clientid: 'c2',
                  clientsecret: 's2',
                  tokenendpoint: 'https://t2.example.com'
                }
              }
            ]
          }
        }
      ]
    };

    const bindings = extractEventMeshBindings(vcap);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.name).toBe('test-em');
    expect(bindings[0]?.namespace).toBe('test-ns');
    expect(bindings[0]?.management.uri).toBe('https://manage.example.com');
    expect(bindings[0]?.messaging.uri).toBe('https://msg.example.com');
    expect(bindings[0]?.messaging.oa2.granttype).toBe('client_credentials');
    expect(bindings[0]?.amqp.uri).toBe('wss://amqp.example.com');
  });

  it('should skip invalid bindings', () => {
    const vcap = {
      'enterprise-messaging': [
        {
          name: 'test-em',
          credentials: {
            // Missing namespace
            management: [],
            messaging: []
          }
        }
      ]
    };
    expect(extractEventMeshBindings(vcap)).toEqual([]);
  });
});
