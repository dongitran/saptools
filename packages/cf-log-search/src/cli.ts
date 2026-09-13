import { fail } from "./cli/output.js";
import { buildProgram } from "./cli/program.js";
import { errorMessage } from "./errors.js";

try {
  await buildProgram().parseAsync(process.argv);
} catch (error) {
  fail(errorMessage(error));
}
