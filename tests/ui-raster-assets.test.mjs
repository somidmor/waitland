import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const profileSource = await readFile(new URL("../app/profile.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(profileSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { createWaitProfile, parseStoredProfile, PROFILE_STORAGE_KEY } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("a visitor enters with only a waiting reason and no invented identity", () => {
  const profile = createWaitProfile("  my coffee  ");
  assert.deepEqual(profile, { name: "", city: "", country: "", countryCode: "", reasonId: "order", reasonText: "my coffee" });
  assert.deepEqual(parseStoredProfile(JSON.stringify(profile)), profile);
  assert.equal(PROFILE_STORAGE_KEY, "waiting-pit-profile-v1");
});

test("stored legacy profiles keep their reason and optional identity", () => {
  const profile = parseStoredProfile(JSON.stringify({ name: "Lina", city: "Vancouver", country: "Canada", countryCode: "ca", reasonId: "person", reasonText: "a friend" }));
  assert.equal(profile.name, "Lina");
  assert.equal(profile.city, "Vancouver");
  assert.equal(profile.countryCode, "CA");
  assert.equal(profile.reasonText, "a friend");
});

test("broken stored data cannot prevent entry and reasons stay bounded", () => {
  for (const value of [null, "", "bad json", "null", "[]", "42", "{}", '{"reasonText":"   "}']) assert.equal(parseStoredProfile(value), null);
  const reason = createWaitProfile("🪨".repeat(55)).reasonText;
  assert.equal(Array.from(reason).length, 50);
  assert.equal(createWaitProfile("<>\u0000").reasonText, "");
  assert.equal(parseStoredProfile('{"reasonText":"the train"}').reasonId, "other");
});

test("the arrival screen stays independent from 3D and external image downloads", async () => {
  const [arrival, loader] = await Promise.all([
    readFile(new URL("../app/arrival-screen.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/game-loader.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(arrival, /from ["']three|\.glb|<img\b|https:\/\//);
  assert.match(loader, /if \(!activeProfile \|\| Game\) return;[\s\S]*import\("\.\/waiting-pit"\)/);
  assert.match(loader, /catch \{[\s\S]*session still works when storage is unavailable/);
});
