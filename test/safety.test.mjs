import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectCommand } from "../src/safety.mjs";

/** A command flagged irreversible returns a hit; a safe one returns null. */
function flagged(cmd) {
  return inspectCommand(cmd) !== null;
}

// --- force-push (history rewrite) ----------------------------------------------------

test("force-push variants are flagged", () => {
  assert.ok(flagged("git push --force"));
  assert.ok(flagged("git push -f origin main"));
  assert.ok(flagged("git push origin main --force-with-lease"));
  assert.equal(inspectCommand("git push --force").category, "history rewrite");
});

test("an ordinary push is not flagged", () => {
  assert.ok(!flagged("git push"));
  assert.ok(!flagged("git push origin main"));
});

// --- irreversible reset --------------------------------------------------------------

test("git reset --hard is flagged; a soft reset is not", () => {
  assert.ok(flagged("git reset --hard HEAD~1"));
  assert.ok(!flagged("git reset --soft HEAD~1"));
  assert.ok(!flagged("git reset"));
});

// --- deletion ------------------------------------------------------------------------

test("rm with -r/-f is flagged; a single-file rm is not", () => {
  assert.ok(flagged("rm -rf node_modules"));
  assert.ok(flagged("rm -fr dist"));
  assert.ok(flagged("rm -r build"));
  assert.ok(flagged("rm -f .env"));
  assert.ok(flagged("rm dir --force"));
  assert.ok(!flagged("rm notes.txt"));
  assert.ok(!flagged("rm -i scratch.txt")); // interactive, no -r/-f
});

test("git clean -f is flagged; a dry run is not", () => {
  assert.ok(flagged("git clean -fd"));
  assert.ok(flagged("git clean --force"));
  assert.ok(!flagged("git clean -n")); // dry run
});

// --- disk overwrite ------------------------------------------------------------------

test("disk destroyers are flagged", () => {
  assert.ok(flagged("dd if=/dev/zero of=/dev/sda"));
  assert.ok(flagged("mkfs.ext4 /dev/sdb1"));
  assert.ok(flagged("shred -u secret.key"));
  assert.ok(flagged("cat junk > /dev/sda"));
  assert.ok(!flagged("dd if=/dev/sda of=backup.img")); // reading a disk, not overwriting one
});

// --- external send -------------------------------------------------------------------

test("external sends are flagged", () => {
  assert.ok(flagged("scp dump.sql user@host.example.com:/tmp/"));
  assert.ok(flagged("rsync -a ./ deploy@server:/srv/app"));
  assert.ok(flagged("curl -X POST https://api.example.com -d @payload.json"));
  assert.ok(flagged("curl --upload-file backup.tar https://files.example.com"));
  assert.equal(inspectCommand("scp x user@h:/p").category, "external send");
});

test("a plain GET fetch and a local copy are not flagged", () => {
  assert.ok(!flagged("curl https://example.com/data.json"));
  assert.ok(!flagged("scp local.txt ./copy.txt"));
});

// --- chaining and edge cases ---------------------------------------------------------

test("a dangerous link buried in a chain is caught", () => {
  assert.ok(flagged("npm test && rm -rf dist"));
  assert.ok(flagged("git add . ; git commit -m wip ; git push --force"));
});

test("a fully safe chain is not flagged", () => {
  assert.ok(!flagged("git add . && git commit -m 'x' && git push"));
  assert.ok(!flagged("npm run lint && npm test"));
});

test("empty / whitespace / nullish input is safe", () => {
  assert.equal(inspectCommand(""), null);
  assert.equal(inspectCommand("   "), null);
  assert.equal(inspectCommand(undefined), null);
});

test("a word merely containing 'rm' is not mistaken for rm", () => {
  assert.ok(!flagged("npm run confirm -- --rf")); // 'confirm' is not the rm command
  assert.ok(!flagged("echo 'perform a backup'"));
});
