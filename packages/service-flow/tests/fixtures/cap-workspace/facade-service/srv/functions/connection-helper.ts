import cds from '@sap/cds';

const createIdentityClient = async () => {
  const identity = await cds.connect.to('identity');
  return identity;
};

const createRulesClient = async () => {
  const rules = await cds.connect.to('rules');
  return rules;
};

const createUnusedClient = async () => {
  return { notAClient: true };
};

export { createIdentityClient, createRulesClient as createRulesRemote, createUnusedClient };
