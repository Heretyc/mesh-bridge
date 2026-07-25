import assert from "node:assert/strict";
import test from "node:test";
import { meshtasticSerialCandidates, type SerialPortInfo } from "./serial.js";

const ports: SerialPortInfo[] = [
  { path: "COM3", vendorId: "239A" },
  { path: "COM4", pnpId: "USB\\VID_239A" },
  { path: "COM5", pnpId: "BTHENUM\\x" },
  { path: "/dev/ttyUSB0" },
  { path: "/dev/ttyACM0" },
  { path: "/dev/ttyS0" },
  { path: "/dev/cu.usbmodem1101" },
  { path: "/dev/tty.usbmodem1101" },
  { path: "/dev/cu.Bluetooth-Incoming-Port" },
];

test("win32 keeps the existing vendorId-or-USB-pnpId selection", () => {
  assert.deepEqual(meshtasticSerialCandidates(ports, "win32").map((port) => port.path), ["COM3", "COM4"]);
});

test("linux accepts ttyUSB and ttyACM devices only", () => {
  assert.deepEqual(meshtasticSerialCandidates(ports, "linux").map((port) => port.path), ["/dev/ttyUSB0", "/dev/ttyACM0"]);
});

test("darwin returns cu devices and never tty devices", () => {
  const selected = meshtasticSerialCandidates(ports, "darwin").map((port) => port.path);
  assert.ok(selected.includes("/dev/cu.usbmodem1101"));
  assert.ok(selected.includes("/dev/cu.Bluetooth-Incoming-Port"));
  assert.ok(selected.every((path) => !path.startsWith("/dev/tty.")));
  assert.equal(selected.filter((path) => path === "/dev/cu.usbmodem1101").length, 1);
});
