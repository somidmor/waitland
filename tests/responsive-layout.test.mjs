import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

const devices = [
  { name: "iPhone SE", width: 375, height: 667, safeTop: 20, safeBottom: 0 },
  { name: "iPhone 15 Pro", width: 393, height: 852, safeTop: 59, safeBottom: 34 },
  { name: "Pixel 7", width: 412, height: 915, safeTop: 24, safeBottom: 24 },
  { name: "iPad mini portrait", width: 768, height: 1024, safeTop: 24, safeBottom: 20 },
];

test("portrait HUD keeps the progress, chat, movement, and action regions separate", () => {
  for (const device of devices) {
    const compact = device.width <= 460;
    const edge = compact ? 15 : 21;
    const gap = compact ? 12 : 14;
    const hudWidth = compact
      ? Math.min(225, device.width * 0.57)
      : Math.min(272, device.width * 0.69);
    const presenceWidth = compact ? 100 : 118;
    assert.ok(
      edge * 2 + hudWidth + gap + presenceWidth <= device.width,
      `${device.name}: top HUD regions overlap`,
    );

    if (device.width < 600) {
      const chatLeft = 14;
      const chatWidth = device.width - 138;
      const actionLeft = device.width - 12 - 92;
      assert.ok(chatWidth >= 220, `${device.name}: chat target is too narrow`);
      assert.ok(actionLeft - (chatLeft + chatWidth) >= 12, `${device.name}: chat overlaps action`);

      const joystickBottom = Math.max(17, device.safeBottom) + 103;
      const joystickTop = device.height - joystickBottom - 99;
      const progressBottom = Math.max(26, device.safeTop + 12) + 31 + 12 + 83;
      assert.ok(joystickTop - progressBottom >= 120, `${device.name}: play field is vertically cramped`);
    } else {
      const centeredChatLeft = (device.width - 400) / 2;
      const actionLeft = device.width - 28 - 106;
      assert.ok(actionLeft - (centeredChatLeft + 400) >= 32, `${device.name}: tablet chat overlaps action`);
    }
  }
});

test("responsive CSS includes phone, tablet, landscape, and safe-area contracts", () => {
  for (const contract of [
    "@media (max-width: 460px)",
    "@media (min-width: 600px) and (max-width: 799px)",
    "@media (orientation: landscape) and (max-height: 600px)",
    "env(safe-area-inset-top)",
    "env(safe-area-inset-bottom)",
    "env(safe-area-inset-left)",
    "env(safe-area-inset-right)",
  ]) {
    assert.ok(css.includes(contract), `missing responsive contract: ${contract}`);
  }

  const compactStart = css.lastIndexOf("@media (max-width: 460px)");
  const compactEnd = css.indexOf("@media", compactStart + 1);
  const compactCss = css.slice(compactStart, compactEnd < 0 ? undefined : compactEnd);
  for (const contract of [
    "width: min(225px, 57vw)",
    "max-width: 100px",
    "width: calc(100vw - 138px)",
    "width: 92px",
  ]) {
    assert.ok(compactCss.includes(contract), `compact phone override missing: ${contract}`);
  }
});

test("coarse-pointer landscape keeps chat between movement and action controls", () => {
  const landscapeDevices = [
    { name: "small landscape phone", width: 568, safeLeft: 0, safeRight: 0 },
    { name: "iPhone SE landscape", width: 667, safeLeft: 0, safeRight: 0 },
    { name: "iPhone 15 Pro landscape", width: 852, safeLeft: 59, safeRight: 59 },
    { name: "Pixel 7 landscape", width: 915, safeLeft: 0, safeRight: 0 },
  ];

  for (const device of landscapeDevices) {
    const joystickLeft = Math.max(20, device.safeLeft);
    const joystickRight = joystickLeft + 90;
    const actionRight = device.width - Math.max(18, device.safeRight);
    const actionLeft = actionRight - 82;
    const chatLeft = joystickLeft + 102;
    const chatWidth = Math.min(
      356,
      device.width - joystickLeft - Math.max(18, device.safeRight) - 196,
    );
    const chatRight = chatLeft + chatWidth;

    assert.ok(chatWidth >= 320, `${device.name}: chat target is too narrow`);
    assert.ok(chatLeft - joystickRight >= 12, `${device.name}: chat overlaps joystick`);
    assert.ok(actionLeft - chatRight >= 12, `${device.name}: chat overlaps action`);
  }

  const coarseLandscapeStart = css.indexOf(
    "@media (orientation: landscape) and (max-height: 600px) and (pointer: coarse)",
  );
  const coarseLandscapeEnd = css.indexOf("@media", coarseLandscapeStart + 1);
  const coarseLandscapeCss = css.slice(
    coarseLandscapeStart,
    coarseLandscapeEnd < 0 ? undefined : coarseLandscapeEnd,
  );
  for (const contract of [
    "left: calc(max(20px, env(safe-area-inset-left)) + 102px)",
    "max(18px, env(safe-area-inset-right)) - 196px",
    "transform: none",
  ]) {
    assert.ok(coarseLandscapeCss.includes(contract), `landscape override missing: ${contract}`);
  }
});
