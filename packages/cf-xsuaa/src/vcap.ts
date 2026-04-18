import type { RawVcapServices, XsuaaCredentials } from "./types.js";

export function extractVcapServicesJson(stdout: string): string {
  const startMarker = "VCAP_SERVICES:";
  const endMarker = "VCAP_APPLICATION:";

  const startIdx = stdout.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error("VCAP_SERVICES section not found in cf env output");
  }

  const afterStart = stdout.slice(startIdx + startMarker.length);
  const endIdx = afterStart.indexOf(endMarker);
  const rawBlock = endIdx === -1 ? afterStart : afterStart.slice(0, endIdx);

  return rawBlock.trim();
}

export function parseXsuaaFromVcap(stdout: string): XsuaaCredentials {
  const jsonBlock = extractVcapServicesJson(stdout);
  const parsed = JSON.parse(jsonBlock) as RawVcapServices;
  const bindings = parsed.xsuaa;
  if (!bindings || bindings.length === 0) {
    throw new Error("No xsuaa service binding found in VCAP_SERVICES");
  }

  const first = bindings[0];
  if (!first) {
    throw new Error("No xsuaa service binding found in VCAP_SERVICES");
  }

  const { clientid, clientsecret, url, xsappname } = first.credentials;
  if (!clientid || !clientsecret || !url) {
    throw new Error("Incomplete xsuaa credentials (missing clientid/clientsecret/url)");
  }

  return {
    clientId: clientid,
    clientSecret: clientsecret,
    url,
    ...(xsappname ? { xsappname } : {}),
  };
}
