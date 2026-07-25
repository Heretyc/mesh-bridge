export interface SerialPortInfo {
  path: string;
  vendorId?: string | undefined;
  pnpId?: string | undefined;
}

function unique<T extends SerialPortInfo>(ports: T[]): T[] {
  const seen = new Set<string>();
  return ports.filter((port) => {
    if (seen.has(port.path)) return false;
    seen.add(port.path);
    return true;
  });
}

export function meshtasticSerialCandidates<T extends SerialPortInfo>(ports: T[], platform: NodeJS.Platform = process.platform): T[] {
  if (platform === "win32") return ports.filter((port) => Boolean(port.vendorId) || /^USB/iu.test(port.pnpId ?? ""));
  if (platform === "linux") return ports.filter((port) => /^\/dev\/tty(?:USB|ACM)\d+$/u.test(port.path));
  if (platform === "darwin") {
    return unique(ports.flatMap((port) => {
      if (/^\/dev\/cu\./u.test(port.path)) return [port];
      if (/^\/dev\/tty\./u.test(port.path)) return [{ ...port, path: port.path.replace("/dev/tty.", "/dev/cu.") } as T];
      return [];
    }));
  }
  return [];
}
