// cspell:words edm edmx Edmx Insertable
import { describe, it, expect, vi, beforeEach } from 'vitest';

import * as cfClient from '../src/cfClient.js';
import type { ApiCatalogDiscoveryOptions } from '../src/discovery.js';
import {
  discoverApiEntities,
  parseCdsServices,
  parseODataMetadata,
  parseSubEntities,
  createEntity,
  normalizeBearerToken,
} from '../src/discovery.js';

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

    it('should parse cds services with @path annotation before the service', () => {
      const content = `
        @path: '/browse'
        service CatalogService {
          entity Books as projection on my.Books;
        }
      `;

      const entities = parseCdsServices(content);

      expect(entities).toHaveLength(1);
      expect(entities[0]?.name).toBe('CatalogService');
      expect(entities[0]?.path).toBe('/browse');
    });

    it('should parse cds services with grouped path annotation before the service', () => {
      const content = `
        @(path: '/admin')
        service AdminService {
          entity Authors as projection on my.Authors;
        }
      `;

      const entities = parseCdsServices(content);

      expect(entities).toHaveLength(1);
      expect(entities[0]?.name).toBe('AdminService');
      expect(entities[0]?.path).toBe('/admin');
    });

    it('should keep unannotated services when another service has an explicit path', () => {
      const content = `
        service CatalogService @(path: '/browse') {
          entity Books as projection on my.Books;
        }

        service AdminService {
          entity Authors as projection on my.Authors;
        }
      `;

      const entities = parseCdsServices(content);

      expect(entities.map((entity) => [entity.name, entity.path])).toEqual([
        ['CatalogService', '/browse'],
        ['AdminService', '/odata/v4/admin'],
      ]);
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

  describe('parseODataMetadata', () => {
    it('derives entity and operation endpoints from OData metadata', () => {
      const metadata = `
        <edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
          <edmx:DataServices>
            <Schema Namespace="CatalogService" xmlns="http://docs.oasis-open.org/odata/ns/edm">
              <EntityContainer Name="EntityContainer">
                <edm:EntitySet Name="Books" EntityType="CatalogService.Books">
                  <edm:Annotation Term="Org.OData.Capabilities.V1.InsertRestrictions">
                    <edm:Record>
                      <edm:PropertyValue Property="Insertable" Bool="false" />
                    </edm:Record>
                  </edm:Annotation>
                  <edm:Annotation Term="Org.OData.Capabilities.V1.DeleteRestrictions">
                    <edm:Record>
                      <edm:PropertyValue Property="Deletable" Bool="false" />
                    </edm:Record>
                  </edm:Annotation>
                </edm:EntitySet>
                <edm:EntitySet Name="Authors" EntityType="CatalogService.Authors" />
                <edm:FunctionImport Name="topBooks" Function="CatalogService.topBooks" />
                <edm:ActionImport Name="resetCatalog" Action="CatalogService.resetCatalog" />
              </EntityContainer>
            </Schema>
          </edmx:DataServices>
        </edmx:Edmx>
      `;

      const entities = parseODataMetadata(metadata, '/odata/v4/catalog', 'CatalogService');

      expect(entities).toEqual([
        {
          name: 'CatalogService / Books',
          path: '/odata/v4/catalog/Books',
          methods: ['GET', 'PATCH'],
          schema: { type: 'object', properties: {} },
        },
        {
          name: 'CatalogService / Authors',
          path: '/odata/v4/catalog/Authors',
          methods: ['GET', 'POST', 'PATCH', 'DELETE'],
          schema: { type: 'object', properties: {} },
        },
        {
          name: 'CatalogService / topBooks',
          path: '/odata/v4/catalog/topBooks',
          methods: ['GET'],
          schema: { type: 'object', properties: {} },
        },
        {
          name: 'CatalogService / resetCatalog',
          path: '/odata/v4/catalog/resetCatalog',
          methods: ['POST'],
          schema: { type: 'object', properties: {} },
        },
      ]);
    });

    it('derives methods from external annotations and single-quoted XML attributes', () => {
      const metadata = `
        <edmx:Edmx xmlns:edmx='http://docs.oasis-open.org/odata/ns/edmx'>
          <edmx:DataServices>
            <Schema Namespace='CatalogService' xmlns='http://docs.oasis-open.org/odata/ns/edm'>
              <EntityContainer Name='EntityContainer'>
                <EntitySet Name='Books' EntityType='CatalogService.Books' />
              </EntityContainer>
              <Annotations Target='CatalogService.EntityContainer/Books'>
                <Annotation Term='Org.OData.Capabilities.V1.InsertRestrictions'>
                  <Record>
                    <PropertyValue Property='Insertable' Bool='false' />
                  </Record>
                </Annotation>
                <Annotation Term='Org.OData.Capabilities.V1.UpdateRestrictions'>
                  <Record>
                    <PropertyValue Property='Updatable' Bool='false' />
                  </Record>
                </Annotation>
                <Annotation Term='Org.OData.Capabilities.V1.DeleteRestrictions'>
                  <Record>
                    <PropertyValue Property='Deletable' Bool='false' />
                  </Record>
                </Annotation>
              </Annotations>
            </Schema>
          </edmx:DataServices>
        </edmx:Edmx>
      `;

      const entities = parseODataMetadata(metadata, '/odata/v4/catalog', 'CatalogService');

      expect(entities).toEqual([
        {
          name: 'CatalogService / Books',
          path: '/odata/v4/catalog/Books',
          methods: ['GET'],
          schema: { type: 'object', properties: {} },
        },
      ]);
    });
  });

  describe('normalizeBearerToken', () => {
    it('should normalize raw bearer tokens', () => {
      expect(normalizeBearerToken('raw-token')).toBe('Bearer raw-token');
    });

    it('should preserve existing bearer authorization scheme case-insensitively', () => {
      expect(normalizeBearerToken('bearer existing-token')).toBe('bearer existing-token');
      expect(normalizeBearerToken('Bearer existing-token')).toBe('Bearer existing-token');
    });

    it('should not treat prefix-looking raw tokens as authorization schemes', () => {
      expect(normalizeBearerToken('bearerTokenValue')).toBe('Bearer bearerTokenValue');
    });

    it('should trim whitespace before normalizing', () => {
      expect(normalizeBearerToken('  raw-token  ')).toBe('Bearer raw-token');
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

    it('normalizes trailing slash base URLs for root discovery', async () => {
      vi.mocked(cfClient.fetchXsuaaTokenFromTarget).mockResolvedValue(null);
      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            endpoints: [
              { name: 'CatalogService', path: '/odata/v4/catalog' },
            ],
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
        } as Response);

      const entities = await discoverApiEntities({
        ...defaultOptions,
        baseUrl: 'http://test.com/',
      });

      expect(entities).toEqual([
        {
          name: 'CatalogService',
          path: '/odata/v4/catalog',
          methods: ['GET', 'POST', 'PATCH', 'DELETE'],
          schema: { type: 'object', properties: {} },
        },
      ]);
      expect(vi.mocked(global.fetch).mock.calls.map(([url]) => url)).toEqual([
        'http://test.com/',
        'http://test.com/odata/v4/catalog/$metadata',
        'http://test.com/odata/v4/catalog',
      ]);
    });

    it('ignores root catalog entries without usable paths', async () => {
      vi.mocked(cfClient.fetchXsuaaTokenFromTarget).mockResolvedValue(null);
      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            endpoints: [
              { name: '', path: '' },
              { name: 'MissingPath' },
              { name: 'CatalogService', path: '/odata/v4/catalog' },
            ],
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
        } as Response);

      const entities = await discoverApiEntities(defaultOptions);

      expect(entities.map((entity) => [entity.name, entity.path])).toEqual([
        ['CatalogService', '/odata/v4/catalog'],
      ]);
    });

    it('fetches an XSUAA token only once across root discovery and expansion', async () => {
      vi.mocked(cfClient.fetchXsuaaTokenFromTarget).mockResolvedValue('fake-token');
      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            endpoints: [
              { name: 'CatalogService', path: '/odata/v4/catalog' },
            ],
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
        } as Response);

      const mutableOptions = { ...defaultOptions };
      await discoverApiEntities(mutableOptions);

      expect(cfClient.fetchXsuaaTokenFromTarget).toHaveBeenCalledTimes(1);
      expect(mutableOptions.token).toBeUndefined();
      expect(vi.mocked(global.fetch).mock.calls.map(([, init]) => init?.headers)).toEqual([
        { Accept: 'application/json', Authorization: 'Bearer fake-token' },
        { Accept: 'application/xml, text/xml, */*', Authorization: 'Bearer fake-token' },
        { Accept: 'application/json', Authorization: 'Bearer fake-token' },
      ]);
    });

    it('expands root service endpoints through OData metadata before falling back to service documents', async () => {
      vi.mocked(cfClient.fetchXsuaaTokenFromTarget).mockResolvedValue('fake-token');
      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            endpoints: [
              { name: 'CatalogService', path: '/odata/v4/catalog' },
            ],
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => `
            <edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
              <edmx:DataServices>
                <Schema Namespace="CatalogService" xmlns="http://docs.oasis-open.org/odata/ns/edm">
                  <EntityContainer Name="EntityContainer">
                    <EntitySet Name="Books" EntityType="CatalogService.Books" />
                  </EntityContainer>
                </Schema>
              </edmx:DataServices>
            </edmx:Edmx>
          `,
        } as Response);

      const entities = await discoverApiEntities(defaultOptions);

      expect(entities).toHaveLength(1);
      expect(entities[0]?.name).toBe('CatalogService / Books');
      expect(entities[0]?.path).toBe('/odata/v4/catalog/Books');
      expect(vi.mocked(global.fetch).mock.calls.map(([url]) => url)).toEqual([
        'http://test.com/',
        'http://test.com/odata/v4/catalog/$metadata',
      ]);
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
