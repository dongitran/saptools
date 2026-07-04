import { describe, it, expect } from 'vitest';

import { extractEventMeshBindings } from '../../src/eventMeshBindings.js';

describe('eventMeshBindings coverage', () => {
  it('should handle non-objects', () => {
    expect(extractEventMeshBindings('string')).toEqual([]);
    expect(extractEventMeshBindings(null)).toEqual([]);
    expect(extractEventMeshBindings(undefined)).toEqual([]);
    expect(extractEventMeshBindings({ 'VCAP_SERVICES': 'string' })).toEqual([]);
    expect(extractEventMeshBindings({ 'VCAP_SERVICES': { 'enterprise-messaging': 'not array' } })).toEqual([]);
  });

  it('should handle malformed services', () => {
    const vcap = {
      'enterprise-messaging': [
        'string', // not a record
        { credentials: 'string' }, // credentials not a record
        { credentials: { namespace: '' } }, // empty namespace
        {
          credentials: {
            namespace: 'ns',
            management: 'not array',
          }
        },
        {
          credentials: {
            namespace: 'ns',
            management: [ { uri: 'manage', oa2: {} } ], // missing oa2 fields
            messaging: [] // empty messaging
          }
        },
        {
          credentials: {
            namespace: 'ns',
            management: [ { uri: 'manage', oa2: { clientid: 'c', clientsecret: 's', tokenendpoint: 't' } } ],
            messaging: [
              { protocol: ['httprest'] } // missing uri
            ]
          }
        }
      ]
    };

    expect(extractEventMeshBindings(vcap)).toEqual([]);
  });

  it('should fallback to generated name', () => {
    const vcap = {
      'enterprise-messaging': [
        {
          credentials: {
            namespace: 'ns',
            management: [{ uri: 'm', oa2: { clientid: 'c', clientsecret: 's', tokenendpoint: 't' } }],
            messaging: [
              { protocol: 'httprest', uri: 'm', oa2: { clientid: 'c', clientsecret: 's', tokenendpoint: 't' } },
              { protocol: 'amqp10ws', uri: 'a', oa2: { clientid: 'c', clientsecret: 's', tokenendpoint: 't' } }
            ]
          }
        }
      ]
    };
    const b = extractEventMeshBindings(vcap);
    expect(b).toHaveLength(1);
    expect(b[0]?.name).toBe('enterprise-messaging-0');
    expect(b[0]?.instanceName).toBe('enterprise-messaging-0');
  });
});
