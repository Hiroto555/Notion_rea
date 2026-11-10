import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { createSharedHttpsServer } from "../src/collaboration/runtime/https-host";
import { HttpSharedProvider } from "../src/collaboration/runtime/http-provider";
import { canonical } from "../src/collaboration/runtime/canonical";
it("authenticates a real TLS 1.3 loopback request and rejects an untrusted certificate", async () => {
  const root = mkdtempSync(join(tmpdir(), "folio-tls-"));
  let authority: SharedAuthority | undefined,
    server: ReturnType<typeof createSharedHttpsServer> | undefined;
  try {
    const config = join(root, "openssl.cnf"),
      keyPath = join(root, "test-key"),
      certPath = join(root, "test-cert");
    writeFileSync(
      config,
      "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=digitalSignature,keyEncipherment,keyCertSign\n",
    );
    const generated = spawnSync(
      "/usr/bin/openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-config",
        config,
        "-days",
        "1",
      ],
      {
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(generated.status, generated.error?.message).toBe(0);
    const key = readFileSync(keyPath, "utf8"),
      cert = readFileSync(certPath, "utf8");
    authority = new SharedAuthority(join(root, "server"));
    const auth = authority.bootstrap({
      orgId: "org",
      userId: "alice",
      deviceId: "dev",
      workspaceId: "space",
      documentId: "page",
      document: {
        type: "doc",
        content: [{ type: "paragraph", attrs: { id: "p1" } }],
      },
    });
    server = createSharedHttpsServer(authority, {
      host: "127.0.0.1",
      port: 0,
      key,
      cert,
    });
    const { url } = await server.listen();
    const body = canonical({ scope: auth.scope });
    const response = await new Promise<{
      body: string;
      protocol: string | null;
    }>((resolve, reject) => {
      const req = httpsRequest(
        url + "/v1/snapshot",
        {
          method: "POST",
          ca: cert,
          rejectUnauthorized: true,
          minVersion: "TLSv1.3",
          headers: {
            authorization: "Bearer " + auth.token,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const protocol = (
            res.socket as import("node:tls").TLSSocket
          ).getProtocol();
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({ body: Buffer.concat(chunks).toString("utf8"), protocol }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    expect(response.protocol).toBe("TLSv1.3");
    expect(JSON.parse(response.body).result.cut).toEqual(authority.head());
    const provider = new HttpSharedProvider(url, auth.token);
    try {
      await expect(provider.snapshot(auth.scope)).rejects.toMatchObject({
        code: "NETWORK_ERROR",
      });
    } finally {
      provider.close();
    }
  } finally {
    await server?.close();
    authority?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
