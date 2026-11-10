/**
 * `bun run licenses:check`: fails when anything the app ships, a package or a bundled Shiki
 * grammar or theme, is under a license outside `build/license-allowlist.json`, unless that
 * file records a reviewed exception, with a reason, for that exact license. It also fails
 * when an Apache-2.0 package that carries a NOTICE file is not named in the root `NOTICE`.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assetLicenseTexts,
  checkShipped,
  collectShipped,
  type Finding,
  loadAllowlist,
} from "./licenses";

const root = resolve(import.meta.dirname, "..");
const shipped = await collectShipped(root);
const allowlist = loadAllowlist(join(root, "build", "license-allowlist.json"));
const result = checkShipped(
  shipped,
  allowlist,
  readFileSync(join(root, "NOTICE"), "utf8"),
  assetLicenseTexts(root),
);

const { packages, grammars, themes } = result.checked;
console.log(
  `Checked the licenses of ${packages} packages, ${grammars} grammars and ${themes} themes the app ships.`,
);

const line = (finding: Finding) =>
  `  ${finding.kind.padEnd(8)} ${finding.version ? `${finding.name}@${finding.version}` : finding.name}  ${finding.license}${finding.where ? `  (${finding.where})` : ""}`;

if (result.excepted.length > 0) {
  console.log(`\nAllowed by a reviewed exception (${result.excepted.length}):`);
  for (const finding of result.excepted)
    console.log(`${line(finding)}\n           ${finding.reason}`);
}
if (result.unusedExceptions.length > 0) {
  console.log("\nExceptions that match nothing shipped any more (remove them):");
  for (const entry of result.unusedExceptions) {
    console.log(`  ${entry.kind.padEnd(8)} ${entry.name}  ${entry.license}`);
  }
}
if (result.violations.length > 0) {
  console.error(
    `\nNot on the license allow-list (${result.violations.length}). Remove the component, or review its license and add an exception with a reason to build/license-allowlist.json:`,
  );
  for (const finding of result.violations) console.error(line(finding));
}
if (result.missingFromNotice.length > 0) {
  console.error(
    "\nApache-2.0 packages with a NOTICE file that the root NOTICE does not name. Add each to its list of bundled components with NOTICE files:",
  );
  for (const pkg of result.missingFromNotice) console.error(`  ${pkg.name}@${pkg.version}`);
}
if (result.missingLicenseText.length > 0) {
  console.error(
    "\nAllowed by an exception, but with no license text to ship. Add the text read upstream as build/asset-licenses/<kind>-<name>.txt:",
  );
  for (const finding of result.missingLicenseText) console.error(line(finding));
}
const failed =
  result.violations.length + result.missingFromNotice.length + result.missingLicenseText.length;
if (failed > 0) process.exit(1);
console.log("\nEvery shipped license is on the allow-list or reviewed.");
