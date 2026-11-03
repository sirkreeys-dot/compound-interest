import { loadEnv } from "../src/config.js";
import { KillSwitch } from "../src/utils/killswitch.js";

const env = loadEnv();
const ks = new KillSwitch(env.killSwitchPath);
const arg = process.argv[2] ?? "pause";
if (arg === "resume") ks.resume();
else ks.pause("cli");
console.log(`Kill switch paused=${ks.isPaused()} file=${env.killSwitchPath}`);
