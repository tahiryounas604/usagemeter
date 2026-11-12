import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  dbPath: string;
  port: number;
  host: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dir = env.USAGEMETER_DIR ?? join(homedir(), ".usagemeter");
  return {
    dbPath: env.USAGEMETER_DB ?? join(dir, "usagemeter.db"),
    port: Number(env.USAGEMETER_PORT ?? env.PORT ?? 8787),
    host: env.USAGEMETER_HOST ?? "127.0.0.1",
  };
}
