import { createServer } from "node:http";
import { WorkspaceBlobStore } from "../../src/sync/workspace-blobs";

const input = JSON.parse(process.env.FOLIO_TEST_SERVER!);
const store = new WorkspaceBlobStore(input.directory);
const server = createServer((request, response) => {
  const start = Number(
    /^bytes (\d+)-/.exec(String(request.headers["content-range"]))?.[1] ?? 0,
  );
  if (request.method === "PUT") process.send?.({ putStart: start });
  if (request.method === "PUT" && input.pauseAt === start) {
    process.send?.({ blocked: true });
    return;
  }
  void store
    .handle(request, response, {
      workspaceId: input.workspaceId,
      sha256: input.sha256,
      assertAuthorized: () => {
        if (request.headers.authorization !== "Bearer " + input.token)
          throw new Error("unauthorized");
      },
    })
    .catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(error.status ?? 500, {
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify({ error: error.code ?? "fixture-error" }));
    });
});
server.listen(input.port ?? 0, "127.0.0.1", () => {
  const address = server.address();
  process.send?.({
    port: typeof address === "object" && address ? address.port : 0,
  });
});
