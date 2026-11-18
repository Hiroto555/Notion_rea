/**
 * Executable entry for the Lv4 bounded capacity measurement.
 *
 * The TypeScript runner is not a package dependency. The parent can bundle
 * this entry with the repository's existing esbuild binary and run the result
 * with Node. See the final report for the exact non-GUI commands.
 */
import { runLv4GoCapacityMeasurement } from "./lv4-go-capacity";

const report = runLv4GoCapacityMeasurement();
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
