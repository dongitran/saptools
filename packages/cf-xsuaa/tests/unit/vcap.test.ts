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

  it("extracts pretty JSON blocks across multiple lines", () => {
    const stdout = [
      "Getting env variables for app ...",
      "VCAP_SERVICES:",
      JSON.stringify({ xsuaa: [] }, null, 2),
      "VCAP_APPLICATION:",
      JSON.stringify({ application_name: "app" }, null, 2),
    ].join("\n");

    expect(JSON.parse(extractVcapServicesJson(stdout))).toEqual({ xsuaa: [] });
  });

  it("works when VCAP_APPLICATION marker missing", () => {
    const stdout = `VCAP_SERVICES: ${JSON.stringify({ hana: [] })}\n`;
    expect(JSON.parse(extractVcapServicesJson(stdout))).toEqual({ hana: [] });
  });

  it("ignores text after VCAP_APPLICATION marker", () => {
    const stdout = [
      `VCAP_SERVICES: ${JSON.stringify({ hana: [] })}`,
      "VCAP_APPLICATION: {}",
      "User-Provided:",
      "OTHER: value",
    ].join("\n");

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

  it("continues selecting the first xsuaa binding when multiple bindings exist", () => {
    const stdout = sampleStdout({
      xsuaa: [
        {
          credentials: {
            clientid: "first",
            clientsecret: "first-secret",
            url: "https://first.example.com",
          },
        },
        {
          credentials: {
            clientid: "second",
            clientsecret: "second-secret",
            url: "https://second.example.com",
          },
        },
      ],
    });

    expect(parseXsuaaFromVcap(stdout)).toMatchObject({
      clientId: "first",
      clientSecret: "first-secret",
      url: "https://first.example.com",
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

  it("throws when xsuaa is not an array", () => {
    const stdout = sampleStdout({ xsuaa: { credentials: {} } });
    expect(() => parseXsuaaFromVcap(stdout)).toThrow();
  });

  it("throws when xsuaa array empty", () => {
    const stdout = sampleStdout({ xsuaa: [] });
    expect(() => parseXsuaaFromVcap(stdout)).toThrow(/xsuaa/);
  });

  it("throws when binding credentials are missing", () => {
    const stdout = sampleStdout({ xsuaa: [{ name: "binding" }] });
    expect(() => parseXsuaaFromVcap(stdout)).toThrow();
  });

  it("throws when credentials incomplete", () => {
    const stdout = sampleStdout({
      xsuaa: [{ credentials: { clientid: "cid", clientsecret: "", url: "" } }],
    });
    expect(() => parseXsuaaFromVcap(stdout)).toThrow(/Incomplete/);
  });

  it("throws when VCAP_SERVICES JSON is invalid", () => {
    const stdout = "VCAP_SERVICES: {not-json}\nVCAP_APPLICATION: {}";
    expect(() => parseXsuaaFromVcap(stdout)).toThrow(SyntaxError);
  });
});
