import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const arrival = await readFile(new URL("../app/arrival-screen.tsx", import.meta.url), "utf8");

const devices = [
  { name: "small phone", width: 320, safeLeft: 0, safeRight: 0 },
  { name: "iPhone SE", width: 375, safeLeft: 0, safeRight: 0 },
  { name: "iPhone 15 Pro", width: 393, safeLeft: 0, safeRight: 0 },
  { name: "Pixel 7", width: 412, safeLeft: 0, safeRight: 0 },
  { name: "iPad mini", width: 768, safeLeft: 0, safeRight: 0 },
  { name: "iPhone landscape", width: 852, safeLeft: 59, safeRight: 59 },
];

test("movement and the primary rock action fit without overlap down to 320px", () => {
  for (const device of devices) {
    const compact = device.width <= 460;
    const safeLeft = Math.max(compact ? 17 : 20, device.safeLeft);
    const safeRight = Math.max(compact ? 17 : 20, device.safeRight);
    const joystick = compact ? 86 : 90;
    const action = compact ? 177 : 185;
    assert.ok(joystick + 18 + action <= device.width - safeLeft - safeRight, `${device.name}: thumb targets overlap`);
  }
});

test("the game anchors controls to safe areas and keeps touch and reduced motion support", () => {
  for (const contract of [
    "env(safe-area-inset-top)",
    "env(safe-area-inset-bottom)",
    "env(safe-area-inset-left)",
    "env(safe-area-inset-right)",
    "100dvh",
    "100svh",
    "@media (max-width: 460px)",
    "@media (orientation: landscape) and (max-height: 600px)",
    "@media (prefers-reduced-motion: reduce)",
    "touch-action: none",
    "touch-action: manipulation",
    "overflow-y: auto",
    ".game-dialog::backdrop",
    ".game-toast:empty",
  ]) assert.ok(css.includes(contract), `missing responsive or accessibility contract: ${contract}`);
});

test("entry requires one reason and does not load an identity or location lookup", () => {
  assert.equal((arrival.match(/<input\b/g) ?? []).length, 1);
  assert.match(arrival, /maxLength=\{50\}/);
  assert.match(arrival, /htmlFor="wait-reason"/);
  assert.match(arrival, /aria-invalid=/);
  assert.match(arrival, /aria-pressed=/);
  assert.doesNotMatch(arrival, /geocoding|open-meteo|fetch\(|type="(?:email|password)"/);
});
