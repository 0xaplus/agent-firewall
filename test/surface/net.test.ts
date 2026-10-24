import { describe, expect, test } from "bun:test";
import { lanUrls, startupMessage, wslHint } from "../../src/net";

const ifaces = {
  lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  wlan0: [
    { address: "192.168.43.12", family: "IPv4", internal: false },
    { address: "fe80::1", family: "IPv6", internal: false },
  ],
  eth0: [{ address: "10.0.0.5", family: "IPv4", internal: false }],
} as any;

describe("LAN addresses", () => {
  test("lists external IPv4 addresses only, with the port", () => {
    expect(lanUrls(3000, ifaces)).toEqual(["http://192.168.43.12:3000/", "http://10.0.0.5:3000/"]);
    expect(lanUrls(3000, { lo: ifaces.lo })).toEqual([]);
  });

  test("the startup message prints localhost and the LAN URLs", () => {
    const msg = startupMessage(4000, ifaces, {});
    expect(msg).toContain("http://localhost:4000/");
    expect(msg).toContain("http://192.168.43.12:4000/");
    expect(msg).not.toContain("WSL");
  });

  test("under WSL it explains how a phone can reach the server", () => {
    expect(wslHint(3000, {})).toBeNull();
    const hint = wslHint(3000, { WSL_DISTRO_NAME: "Ubuntu" })!;
    expect(hint).toContain("mirrored");
    expect(hint).toContain("listenport=3000");
    expect(startupMessage(3000, ifaces, { WSL_DISTRO_NAME: "Ubuntu" })).toContain("Running in WSL");
  });
});
