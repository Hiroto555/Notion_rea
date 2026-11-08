import { SharedDraftStore } from "../../src/collaboration/draft-store";
const store = new SharedDraftStore(process.argv[2]);
process.send?.("OPEN");
process.on("message", (message) => {
  if (message === "STAGE") {
    store.stage(JSON.parse(process.argv[3]));
    process.send?.("STAGED");
  }
});
