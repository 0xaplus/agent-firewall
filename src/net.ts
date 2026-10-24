import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>;

// URLs another device on the same network (a phone on the hotspot) can open.
export function lanUrls(port: number, ifaces: Interfaces = networkInterfaces()): string[] {
  return Object.values(ifaces)
    .flat()
    .filter((i): i is NetworkInterfaceInfo => !!i && i.family === "IPv4" && !i.internal)
    .map((i) => `http://${i.address}:${port}/`);
}

// Under WSL2 the addresses above belong to a virtual network that phones can't reach.
export function wslHint(port: number, env: Record<string, string | undefined> = process.env): string | null {
  if (!env.WSL_DISTRO_NAME) return null;
  return [
    "Running in WSL: a phone can't reach these addresses directly. Either turn on mirrored networking",
    "(networkingMode=mirrored in %UserProfile%\\.wslconfig, then `wsl --shutdown`), or forward the port from an admin PowerShell:",
    `  netsh interface portproxy add v4tov4 listenport=${port} listenaddress=0.0.0.0 connectport=${port} connectaddress=$(wsl hostname -I).Trim()`,
    "and open the Windows machine's Wi-Fi address on the phone (allow the port in Windows Firewall if asked).",
  ].join("\n");
}

export function startupMessage(port: number, ifaces?: Interfaces, env?: Record<string, string | undefined>): string {
  const lines = [`Spend Firewall listening on http://localhost:${port}/`];
  const lan = lanUrls(port, ifaces);
  if (lan.length) lines.push(`On your network (open on a phone on the same Wi-Fi): ${lan.join("  ")}`);
  const hint = wslHint(port, env);
  if (hint) lines.push(hint);
  return lines.join("\n");
}
