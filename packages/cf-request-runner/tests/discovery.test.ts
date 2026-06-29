import { describe, it, expect, vi, beforeEach } from 'vitest';

import * as cfClient from '../src/cfClient.js';
import type { ApiCatalogDiscoveryOptions } from '../src/discovery.js';
import { discoverApiEntities, parseCdsServices, parseSubEntities, createEntity } from '../src/discovery.js';

vi.mock('../src/cfClient.js', () => ({
  fetchXsuaaTokenFromTarget: vi.fn(),
  fetchRemoteCdsServicesFromTarget: vi.fn(),
}));

describe('discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  describe('parseCdsServices', () => {
    it('should parse cds services with @(path: ...) annotation', () => {
      const content = `
        service CatalogService @(path: '/browse') {
          entity Books as projection on my.Books;
        }
      `;
      const entities = parseCdsServices(content);
      expect(entities).toHaveLength(1);
      expect(entities[0]?.name).toBe('CatalogService');
      expect(entities[0]?.path).toBe('/browse');
      expect(entities[0]?.methods).toEqual(['GET', 'POST', 'PATCH', 'DELETE']);
    });

    it('should fallback to default OData path if no path annotation is present', () => {
      const content = `
        service AdminService {
          entity Authors as projection on my.Authors;
        }
      `;
      const entities = parseCdsServices(content);
      expect(entities).toHaveLength(1);
      expect(entities[0]?.name).toBe('AdminService');
      expect(entities[0]?.path).toBe('/odata/v4/admin');
    });
  });

  describe('parseSubEntities', () => {
    it('should parse sub entities from root json', () => {
      const parent = createEntity('Root', '/root');
      const value = {
        value: [
          { name: 'Entity1', url: 'Entity1' },
          { name: 'Entity2', url: 'Entity2Path' }
        ]
      };

      const subEntities = parseSubEntities(value, parent);
      expect(subEntities).toHaveLength(2);
      expect(subEntities[0]?.name).toBe('Root / Entity1');
      expect(subEntities[0]?.path).toBe('/root/Entity1');
      expect(subEntities[1]?.name).toBe('Root / Entity2');
      expect(subEntities[1]?.path).toBe('/root/Entity2Path');
    });

    it('should ignore invalid entries', () => {
      const parent = createEntity('Root', '/root');
      const value = {
        value: [
          { name: '' },
          { something: 'else' },
          "not an object"
        ]
      };

      const subEntities = parseSubEntities(value, parent);
      expect(subEntities).toHaveLength(0);
    });
  });

  describe('discoverApiEntities', () => {
    const defaultOptions: ApiCatalogDiscoveryOptions = {
      appId: 'test-app',
      baseUrl: 'http://test.com',
      log: vi.fn(),
      onDeepDiscoveryStart: vi.fn(),
    };

    it('should discover root entities via fetch', async () => {
      vi.mocked(cfClient.fetchXsuaaTokenFromTarget).mockResolvedValue('fake-token');
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          endpoints: [
            { name: 'Service1', path: '/odata/v4/service1' }
          ]
        })
      } as Response);

      const entities = await discoverApiEntities(defaultOptions);

      expect(entities).toHaveLength(1);
      expect(entities[0]?.name).toBe('Service1');
      expect(entities[0]?.path).toBe('/odata/v4/service1');
    });

    it('should fallback to CDS SSH if root discovery fails', async () => {
      vi.mocked(cfClient.fetchXsuaaTokenFromTarget).mockResolvedValue(null);
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false
      } as Response);

      vi.mocked(cfClient.fetchRemoteCdsServicesFromTarget).mockResolvedValue(`
        service CdsService @(path: '/cds') {}
      `);

      const entities = await discoverApiEntities(defaultOptions);

      expect(entities).toHaveLength(1);
      expect(entities[0]?.name).toBe('CdsService');
      expect(entities[0]?.path).toBe('/cds');
    });
  });
});
