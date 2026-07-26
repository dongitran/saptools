import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { classifyOutboundCallsInSource } from '../../src/parsers/outbound-call-parser.js';
import { reconcileBindingAndCallIdentity } from '../../src/parsers/006-binding-identity.js';
import { createBindingLexicalIndex } from '../../src/parsers/011-binding-lexical-scope.js';
import { parseServiceBindings } from '../../src/parsers/service-binding-parser.js';
import type {
  OutboundCallFact,
  ServiceBindingFact,
  ServiceBindingReference,
} from '../../src/types.js';

interface PreparedFixture {
  bindings: ServiceBindingFact[];
  calls: OutboundCallFact[];
}

async function prepare(sourceText: string): Promise<PreparedFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-binding-scope-'));
  const file = 'scope.ts';
  await fs.writeFile(path.join(root, file), sourceText);
  const source = ts.createSourceFile(
    file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  );
  const bindings = await parseServiceBindings(root, file);
  const calls = classifyOutboundCallsInSource(source, file)
    .map((item) => item.fact);
  return reconcileBindingAndCallIdentity(source, bindings, calls, []);
}

function reference(
  fixture: PreparedFixture,
  operation: string,
): ServiceBindingReference {
  const call = fixture.calls.find((item) => item.operationPathExpr === operation);
  if (!call?.serviceBindingReference)
    throw new Error(`missing binding reference for ${operation}`);
  return call.serviceBindingReference;
}

function selectedAlias(
  fixture: PreparedFixture,
  bindingReference: ServiceBindingReference,
): string | undefined {
  return selectedBinding(fixture, bindingReference)?.alias;
}

function selectedBinding(
  fixture: PreparedFixture,
  bindingReference: ServiceBindingReference,
): ServiceBindingFact | undefined {
  return fixture.bindings.find((binding) =>
    binding.bindingSiteStartOffset === bindingReference.bindingSiteStartOffset
    && binding.bindingSiteEndOffset === bindingReference.bindingSiteEndOffset
  );
}

function expectResolved(
  fixture: PreparedFixture,
  operation: string,
  alias: string,
): void {
  const selected = reference(fixture, operation);
  expect(selected.status).toBe('resolved_exact');
  expect(selectedAlias(fixture, selected)).toBe(alias);
}

const nestedShadowSource = `
  import cds from '@sap/cds';
  async function run(): Promise<void> {
    const client = await cds.connect.to('outer-service');
    function nested(): void {
      const client = cds.connect.to('inner-service');
      client.send({ method: 'POST', path: '/inner' });
    }
    const alias = client;
    alias.send({ method: 'POST', path: '/outer-alias' });
    nested();
  }
`;

const blockShadowSource = `
  import cds from '@sap/cds';
  async function run(): Promise<void> {
    const client = await cds.connect.to('outer-service');
    {
      const client = await cds.connect.to('block-service');
      client.send({ method: 'POST', path: '/block' });
    }
    client.send({ method: 'POST', path: '/after-block' });
  }
`;

const globalShadowSource = `
  import cds from '@sap/cds';
  const client = cds.connect.to('global-service');
  client.send({ method: 'POST', path: '/global' });
  async function run(): Promise<void> {
    const client = await cds.connect.to('local-service');
    client.send({ method: 'POST', path: '/local' });
  }
`;

const topLevelBlocksSource = `
  import cds from '@sap/cds';
  {
    const client = cds.connect.to('first-service');
    client.send({ method: 'POST', path: '/first' });
  }
  {
    const client = cds.connect.to('second-service');
    client.send({ method: 'POST', path: '/second' });
  }
`;

const failClosedSource = `
  import cds from '@sap/cds';
  const client = cds.connect.to('global-service');
  async function before(): Promise<void> {
    client.send({ method: 'POST', path: '/before-declaration' });
    const client = cds.connect.to('late-service');
    void client;
  }
  async function branch(flag: boolean): Promise<void> {
    let client = cds.connect.to('base-service');
    if (flag) client = cds.connect.to('branch-service');
    client.send({ method: 'POST', path: '/after-branch' });
    const alias = client;
    alias.send({ method: 'POST', path: '/branch-alias' });
  }
`;

const unsupportedReassignmentSource = `
  import cds from '@sap/cds';
  declare function chooseClient(): unknown;
  async function direct(): Promise<void> {
    let client = cds.connect.to('base-service');
    client = chooseClient();
    client.send({ method: 'POST', path: '/unsupported-direct' });
  }
  async function conditional(flag: boolean): Promise<void> {
    let client = cds.connect.to('branch-base-service');
    if (flag) client = chooseClient();
    client.send({ method: 'POST', path: '/unsupported-conditional' });
  }
  async function logical(): Promise<void> {
    let client = cds.connect.to('logical-base-service');
    client ||= chooseClient();
    client.send({ method: 'POST', path: '/unsupported-logical' });
  }
  async function compound(): Promise<void> {
    let client = cds.connect.to('compound-base-service');
    client += chooseClient();
    client.send({ method: 'POST', path: '/unsupported-compound' });
  }
`;

const shortCircuitAssignmentSource = `
  import cds from '@sap/cds';
  async function logical(flag: boolean, maybe: {
    configure?: (value: unknown) => void;
  }): Promise<void> {
    let andClient = cds.connect.to('and-base-service');
    flag && (andClient = cds.connect.to('and-conditional-service'));
    andClient.send({ method: 'POST', path: '/after-and' });
    let orClient = cds.connect.to('or-base-service');
    flag || (orClient = cds.connect.to('or-conditional-service'));
    orClient.send({ method: 'POST', path: '/after-or' });
    let nullishClient = cds.connect.to('nullish-base-service');
    flag ?? (nullishClient = cds.connect.to('nullish-conditional-service'));
    nullishClient.send({ method: 'POST', path: '/after-nullish' });
    let optionalClient = cds.connect.to('optional-base-service');
    maybe.configure?.(
      optionalClient = cds.connect.to('optional-conditional-service'),
    );
    optionalClient.send({ method: 'POST', path: '/after-optional' });
  }
`;

const unsupportedControlFlowSource = `
  import cds from '@sap/cds';
  async function loop(flag: boolean): Promise<void> {
    let client = cds.connect.to('loop-base-service');
    while (flag) {
      client.send({ method: 'POST', path: '/loop-backedge' });
      client = cds.connect.to('loop-next-service');
      flag = false;
    }
  }
  async function captured(): Promise<void> {
    let client = cds.connect.to('captured-base-service');
    const mutate = (): void => {
      client = cds.connect.to('captured-next-service');
    };
    mutate();
    client.send({ method: 'POST', path: '/captured-assignment' });
  }
  async function nestedLoop(outer: boolean, inner: boolean): Promise<void> {
    let client = cds.connect.to('nested-loop-base-service');
    while (outer) {
      while (inner) {
        client.send({ method: 'POST', path: '/nested-loop-backedge' });
        inner = false;
      }
      client = cds.connect.to('nested-loop-next-service');
      outer = false;
    }
  }
  let fieldClient = cds.connect.to('field-base-service');
  class DeferredField {
    value = (fieldClient = cds.connect.to('field-deferred-service'));
  }
  fieldClient.send({ method: 'POST', path: '/deferred-field-write' });
  void DeferredField;
`;

const lexicalRegionSource = `
  import cds from '@sap/cds';
  for (
    let loopClient = cds.connect.to('loop-service');
    false;
  ) {
    loopClient.send({ method: 'POST', path: '/inside-loop' });
  }
  loopClient.send({ method: 'POST', path: '/after-loop' });
  const selectedCase = 'second';
  switch (selectedCase) {
    case 'first':
      const caseClient = cds.connect.to('case-service');
      caseClient.send({ method: 'POST', path: '/inside-case' });
      break;
    case 'second':
      caseClient.send({ method: 'POST', path: '/cross-case' });
      break;
  }
  namespace FirstScope {
    const namespaceClient = cds.connect.to('namespace-service');
    namespaceClient.send({ method: 'POST', path: '/inside-namespace' });
  }
  namespace SecondScope {
    namespaceClient.send({ method: 'POST', path: '/cross-namespace' });
  }
`;

const lexicalWriteAndShadowSource = `
  import cds from '@sap/cds';
  declare const values: unknown[];
  declare const keys: Record<string, unknown>;
  let loopClient = cds.connect.to('loop-write-service');
  for (loopClient of values) {
    loopClient.send({ method: 'POST', path: '/for-of-write' });
  }
  loopClient.send({ method: 'POST', path: '/after-for-of-write' });
  let keyClient = cds.connect.to('key-write-service');
  for (keyClient in keys) {
    keyClient.send({ method: 'POST', path: '/for-in-write' });
  }
  keyClient.send({ method: 'POST', path: '/after-for-in-write' });
  let incrementedClient = cds.connect.to('increment-service');
  incrementedClient++;
  incrementedClient.send({ method: 'POST', path: '/after-increment' });
  const outerClient = cds.connect.to('outer-service');
  function functionShadow(): void {
    function outerClient(): void {}
    outerClient.send({ method: 'POST', path: '/function-shadow' });
  }
  function classShadow(): void {
    class outerClient {}
    outerClient.send({ method: 'POST', path: '/class-shadow' });
  }
  const namedFunction = function outerClient(): void {
    outerClient.send({ method: 'POST', path: '/named-function-shadow' });
  };
  const namedClass = class outerClient {
    run(): void {
      outerClient.send({ method: 'POST', path: '/named-class-shadow' });
    }
  };
  namespace namespaceScope {
    namespace outerClient {}
    outerClient.send({ method: 'POST', path: '/namespace-value-shadow' });
  }
  void functionShadow;
  void classShadow;
  void namedFunction;
  void namedClass;
`;

const hoistedVarSource = `
  import cds from '@sap/cds';
  const client = cds.connect.to('outer-service');
  function branch(flag: boolean): void {
    if (flag) {
      var client = cds.connect.to('var-branch-service');
    }
    client.send({ method: 'POST', path: '/after-var-branch' });
  }
  function loop(): void {
    for (var client of [cds.connect.to('var-loop-service')]) {
      void client;
    }
    client.send({ method: 'POST', path: '/after-var-loop' });
  }
  void branch;
  void loop;
`;

const nestedDestructuringWriteSource = `
  import cds from '@sap/cds';
  declare const value: unknown;
  async function run(): Promise<void> {
    let first = cds.connect.to('first-service');
    ({ ...first } = value);
    first.send({ method: 'POST', path: '/object-rest-write' });
    let second = cds.connect.to('second-service');
    [ ...second ] = value;
    second.send({ method: 'POST', path: '/array-rest-write' });
    let third = cds.connect.to('third-service');
    ({ nested: { third } } = value);
    third.send({ method: 'POST', path: '/nested-object-write' });
    let fourth = cds.connect.to('fourth-service');
    [[fourth]] = value;
    fourth.send({ method: 'POST', path: '/nested-array-write' });
    let fifth = cds.connect.to('fifth-service');
    [fifth = value] = [value];
    fifth.send({ method: 'POST', path: '/array-default-write' });
    let sixth = cds.connect.to('sixth-service');
    ({ nested: sixth = value } = { nested: value });
    sixth.send({ method: 'POST', path: '/object-default-write' });
    let seventh = cds.connect.to('seventh-service');
    (seventh as unknown) = value;
    seventh.send({ method: 'POST', path: '/as-wrapped-write' });
    let eighth = cds.connect.to('eighth-service');
    (<unknown>eighth) = value;
    eighth.send({ method: 'POST', path: '/assertion-wrapped-write' });
    let ninth = cds.connect.to('ninth-service');
    (ninth!) = value;
    ninth.send({ method: 'POST', path: '/non-null-wrapped-write' });
  }
`;

const ownerlessSource = `
  import cds from '@sap/cds';
  const globalClient = cds.connect.to('global-service');
  globalClient.send({ method: 'POST', path: '/global-ownerless' });
  {
    const scopedClient = cds.connect.to('scoped-service');
    void scopedClient;
  }
  scopedClient.send({ method: 'POST', path: '/scoped-invisible' });
`;

const helperProvenanceSource = `
  import cds from '@sap/cds';
  function makeOuter() {
    const client = cds.connect.to('outer-service');
    function nested(): void {
      const client = cds.connect.to('inner-service');
      void client;
    }
    return { client };
  }
  function ambiguous(flag: boolean) {
    const client = flag
      ? cds.connect.to('first-branch-service')
      : cds.connect.to('second-branch-service');
    return client;
  }
  async function run(req: unknown): Promise<void> {
    const client = cds.connect.to('outer-service');
    function nested(): void {
      const client = cds.connect.to('inner-service');
      const clients = makeOuter();
      void client;
      void clients;
    }
    const directAlias = client;
    const transactionAlias = client.tx(req);
    const [arrayAlias] = [client];
    const clients = makeOuter();
    const objectAlias = clients.client;
    const ambiguousClient = ambiguous(true);
    directAlias.send({ method: 'POST', path: '/direct-alias' });
    transactionAlias.send({ method: 'POST', path: '/transaction-alias' });
    arrayAlias.send({ method: 'POST', path: '/array-alias' });
    objectAlias.send({ method: 'POST', path: '/object-alias' });
    ambiguousClient.send({ method: 'POST', path: '/ambiguous-helper' });
    nested();
  }
`;

function expectUnresolved(
  fixture: PreparedFixture,
  operation: string,
  reason: string,
): void {
  expect(reference(fixture, operation)).toMatchObject({
    status: 'unresolved',
    reason,
  });
}

describe('lexical service-binding shadow identity', () => {
  it('keeps a later outer alias on the outer binding after a nested shadow', async () => {
    const fixture = await prepare(nestedShadowSource);
    expectResolved(fixture, '/inner', 'inner-service');
    expectResolved(fixture, '/outer-alias', 'outer-service');
  });

  it('selects same-function block shadows without leaking after the block', async () => {
    const fixture = await prepare(blockShadowSource);
    expectResolved(fixture, '/block', 'block-service');
    expectResolved(fixture, '/after-block', 'outer-service');
  });

  it('keeps global and local shadows independent', async () => {
    const fixture = await prepare(globalShadowSource);
    expectResolved(fixture, '/global', 'global-service');
    expectResolved(fixture, '/local', 'local-service');
  });
});

describe('lexical service-binding ownerless identity', () => {
  it('distinguishes ownerless bindings in independent top-level blocks', async () => {
    const fixture = await prepare(topLevelBlocksSource);
    expectResolved(fixture, '/first', 'first-service');
    expectResolved(fixture, '/second', 'second-service');
    expect(fixture.bindings.map((binding) => binding.ownerResolution))
      .toEqual(['ownerless_file_scope', 'ownerless_file_scope']);
  });

  it('allows an ownerless call only its exact global binding, never a scoped peer', async () => {
    const fixture = await prepare(ownerlessSource);
    expectResolved(fixture, '/global-ownerless', 'global-service');
    expectUnresolved(fixture, '/scoped-invisible', 'binding_not_found');
  });
});

describe('lexical service-binding fail-closed provenance', () => {
  it('fails closed for TDZ and branch-dependent reaching assignments', async () => {
    const fixture = await prepare(failClosedSource);
    expectUnresolved(
      fixture, '/before-declaration', 'binding_declared_after_call',
    );
    expectUnresolved(
      fixture, '/after-branch', 'unsupported_reaching_assignment',
    );
    expectUnresolved(fixture, '/branch-alias', 'binding_not_found');
  });

  it('does not reuse an older binding after an unsupported assignment', async () => {
    const fixture = await prepare(unsupportedReassignmentSource);
    expectUnresolved(
      fixture, '/unsupported-direct', 'unsupported_reaching_assignment',
    );
    expectUnresolved(
      fixture, '/unsupported-conditional',
      'unsupported_reaching_assignment',
    );
    expectUnresolved(
      fixture, '/unsupported-logical', 'unsupported_reaching_assignment',
    );
    expectUnresolved(
      fixture, '/unsupported-compound', 'unsupported_reaching_assignment',
    );
  });

  it('fails closed for short-circuit and optional-chain assignments', async () => {
    const fixture = await prepare(shortCircuitAssignmentSource);
    for (const operation of [
      '/after-and',
      '/after-or',
      '/after-nullish',
      '/after-optional',
    ]) expectUnresolved(
      fixture, operation, 'unsupported_reaching_assignment',
    );
  });

  it('fails closed for loop backedges and captured nested assignments', async () => {
    const fixture = await prepare(unsupportedControlFlowSource);
    for (const operation of [
      '/loop-backedge',
      '/captured-assignment',
      '/nested-loop-backedge',
      '/deferred-field-write',
    ]) expectUnresolved(
      fixture, operation, 'unsupported_reaching_assignment',
    );
  });

  it('marks root logical assignments as conditional lexical sites', () => {
    const text = `
      let first = base();
      first ||= next();
      let second = base();
      second &&= next();
      let third = base();
      third ??= next();
    `;
    const source = ts.createSourceFile(
      'logical.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
    );
    const assignments = createBindingLexicalIndex(source).sites.filter(
      (site) => site.flow === 'assignment',
    );
    expect(assignments).toHaveLength(3);
    expect(assignments.every((site) => !site.deterministic)).toBe(true);
  });

  it('keeps loop, switch-case, and namespace bindings in their regions', async () => {
    const fixture = await prepare(lexicalRegionSource);
    expectResolved(fixture, '/inside-loop', 'loop-service');
    expectResolved(fixture, '/inside-case', 'case-service');
    expectResolved(fixture, '/inside-namespace', 'namespace-service');
    for (const operation of [
      '/after-loop',
      '/cross-namespace',
    ]) expectUnresolved(fixture, operation, 'binding_not_found');
    expectUnresolved(
      fixture, '/cross-case', 'binding_flow_unsupported',
    );
  });

  it('fails closed for loop writes, mutations, and value-space shadows', async () => {
    const fixture = await prepare(lexicalWriteAndShadowSource);
    for (const operation of [
      '/for-of-write',
      '/after-for-of-write',
      '/for-in-write',
      '/after-for-in-write',
      '/after-increment',
    ]) expectUnresolved(
      fixture, operation, 'unsupported_reaching_assignment',
    );
    for (const operation of [
      '/function-shadow',
      '/class-shadow',
      '/named-function-shadow',
      '/named-class-shadow',
      '/namespace-value-shadow',
    ]) expectUnresolved(fixture, operation, 'binding_flow_unsupported');
  });

  it('treats block and loop var declarations as hoisted unsupported shadows', async () => {
    const fixture = await prepare(hoistedVarSource);
    expectUnresolved(
      fixture, '/after-var-branch', 'unsupported_var_binding',
    );
    expectUnresolved(
      fixture, '/after-var-loop', 'unsupported_var_binding',
    );
  });

  it('fails closed for nested and rest destructuring writes', async () => {
    const fixture = await prepare(nestedDestructuringWriteSource);
    for (const operation of [
      '/object-rest-write',
      '/array-rest-write',
      '/nested-object-write',
      '/nested-array-write',
      '/array-default-write',
      '/object-default-write',
      '/as-wrapped-write',
      '/assertion-wrapped-write',
      '/non-null-wrapped-write',
    ]) expectUnresolved(
      fixture, operation, 'unsupported_reaching_assignment',
    );
  });

  it('keeps direct, transaction, array, object, and helper provenance lexical', async () => {
    const fixture = await prepare(helperProvenanceSource);
    for (const operation of [
      '/direct-alias',
      '/transaction-alias',
      '/array-alias',
      '/object-alias',
    ]) expectResolved(fixture, operation, 'outer-service');
    expect(selectedBinding(
      fixture, reference(fixture, '/transaction-alias'),
    )?.helperChain?.at(-1)).toMatchObject({
      aliasKind: 'transaction',
      scopeRule: 'exact_lexical_scope',
    });
    expect(selectedBinding(
      fixture, reference(fixture, '/array-alias'),
    )?.helperChain?.at(-1)).toMatchObject({
      aliasKind: 'array-destructuring',
      arrayIndex: 0,
      scopeRule: 'exact_lexical_scope',
    });
    expectUnresolved(
      fixture, '/ambiguous-helper', 'binding_flow_unsupported',
    );
  });
});
