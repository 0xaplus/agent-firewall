import { openCoreFromEnv } from "./core.factory";

export { createCore, createCoreFromEnv, openCoreFromEnv } from "./core.factory";
export const { core, db } = openCoreFromEnv();
