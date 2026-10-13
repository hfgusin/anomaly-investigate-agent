// 隔离预览：真实配置与模型，独立临时内存数据库，不重启用户的 Gateway。
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { readConfig } from "../dist/config.js";
import { SessionStore } from "../dist/session-store.js";
import { createApplication } from "../dist/server.js";

const root = resolve(import.meta.dirname, "..");
loadEnvFile(resolve(root, ".env"));
const config = readConfig(process.env, root);
const store = new SessionStore(":memory:");
const app = await createApplication(store, config.runtime, config.timeoutMs, config.tools, config.contextBudgetChars, config.skills);
app.server.listen(18891, "127.0.0.1", () => console.log("隔离预览：http://127.0.0.1:18891（关闭后会话不保留）"));
process.once("SIGINT", async () => { await app.close(); store.close(); process.exit(0); });
process.once("SIGTERM", async () => { await app.close(); store.close(); process.exit(0); });
