import { SessionStore } from "../../dist/session-store.js";
import { DemoRuntime } from "../../dist/runtime.js";
import { createApplication } from "../../dist/server.js";

const store = new SessionStore(process.argv[2]);
const recovered = store.recoverInterrupted();
const app = await createApplication(store, new DemoRuntime());
app.server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: app.server.address().port, recovered }) + "\n");
});
