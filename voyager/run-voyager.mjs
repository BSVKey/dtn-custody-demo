// node voyager/run-voyager.mjs [--mission voyager1|voyager2] [--ber 1e-5] [--seed 7] [--json]
// One run of voyager/mission.mjs. --json prints one VOYAGER_RESULT line.
import { runMission } from "./mission.mjs";

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const json = process.argv.includes("--json");
const result = runMission(arg("--mission", "voyager1"), {
  ber: Number(arg("--ber", 0)), seed: Number(arg("--seed", 7)),
  log: json ? () => {} : (s = "") => console.log(s),
});
if (json) console.log("VOYAGER_RESULT " + JSON.stringify(result));
process.exitCode = result.ok ? 0 : 1;
