import {
  stageCheckpointAssets,
  uploadCheckpointAssets,
} from "../../src/sync/workspace-blobs";

const input = JSON.parse(process.env.FOLIO_TEST_TRANSFER!);
const work =
  input.direction === "download"
    ? stageCheckpointAssets
    : uploadCheckpointAssets;
void work(input.options, [input.asset])
  .then(() => {
    process.send?.({ done: true }, () => process.exit(0));
  })
  .catch((error) => {
    process.send?.({ error: error?.code ?? String(error) }, () =>
      process.exit(1),
    );
  });
