import { describe, expect, it } from "vitest";

import { extractVcapServicesJson, parseXsuaaFromVcap } from "../../src/vcap.js";

const sampleStdout = (vcap: unknown): string =>
  [
    "Getting env variables for app ...",
    "",
    "System-Provided:",
    `VCAP_SERVICES: ${JSON.stringify(vcap)}`,
    "",
    "VCAP_APPLICATION: {}",
    "",
  ].join("\n");

describe("extractVcapServicesJson", () => {
  it("extracts the JSON block", () => {
    const stdout = sampleStdout({ hana: [] });
    const json = extractVcapServicesJson(stdout);
    expect(JSON.parse(json)).toEqual({ hana: [] });
  });

  it("works when VCAP_APPLICATION marker missing", () => {
    const stdout = `VCAP_SERVICES: ${JSON.stringify({ hana: [] })}\n`;
    expect(JSON.parse(extractVcapServicesJson(stdout))).toEqual({ hana: [] });
  });

  it("throws when section not found", () => {
    expect(() => extractVcapServicesJson("nothing")).toThrow(/VCAP_SERVICES/);
  });
});

describe("parseXsuaaFromVcap", () => {
  it("parses the first xsuaa binding", () => {
    const stdout = sampleStdout({
      xsuaa: [
        {
          name: "my-xsuaa",
          credentials: {
            clientid: "cid",
            clientsecret: "csecret",
            url: "https://uaa.example.com",
            xsappname: "my-app",
          },
        },
      ],
    });
    const creds = parseXsuaaFromVcap(stdout);
    expect(creds).toEqual({
      clientId: "cid",
      clientSecret: "csecret",
      url: "https://uaa.example.com",
      xsappname: "my-app",
    });
  });

  it("omits xsappname when missing", () => {
    const stdout = sampleStdout({
      xsuaa: [
        {
          credentials: {
            clientid: "cid",
            clientsecret: "csecret",
            url: "https://uaa.example.com",
          },
        },
      ],
    });
    const creds = parseXsuaaFromVcap(stdout);
    expect(creds.xsappname).toBeUndefined();
  });

  it("throws when no xsuaa bindings", () => {
    const stdout = sampleStdout({ hana: [] });
    expect(() => parseXsuaaFromVcap(stdout)).toThrow(/xsuaa/);
  });

  it("throws when xsuaa array empty", () => {
    const stdout = sampleStdout({ xsuaa: [] });
    expect(() => parseXsuaaFromVcap(stdout)).toThrow(/xsuaa/);
  });

  it("throws when credentials incomplete", () => {
    const stdout = sampleStdout({
      xsuaa: [{ credentials: { clientid: "cid", clientsecret: "", url: "" } }],
    });
    expect(() => parseXsuaaFromVcap(stdout)).toThrow(/Incomplete/);
  });
});
