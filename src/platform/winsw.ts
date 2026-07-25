export interface WinswConfigInput {
  nodePath: string;
  servicePath: string;
  workingDirectory: string;
}

function xml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

export function winswXml(input: WinswConfigInput): string {
  const base = xml(input.workingDirectory);
  return `<service>
  <id>MeshBridge</id>
  <name>Mesh Bridge</name>
  <description>Discord to Meshtastic USB serial bridge</description>
  <executable>${xml(input.nodePath)}</executable>
  <arguments>&quot;${xml(input.servicePath)}&quot;</arguments>
  <workingdirectory>${base}</workingdirectory>
  <startmode>Automatic</startmode>
  <delayedAutoStart/>
  <serviceaccount>
    <domain>NT AUTHORITY</domain>
    <user>LocalService</user>
  </serviceaccount>
  <stoptimeout>20 sec</stoptimeout>
  <onfailure action="restart" delay="10 sec" />
  <resetfailure>1 hour</resetfailure>
  <logpath>${base}\\logs</logpath>
  <log mode="roll"></log>
</service>
`;
}
