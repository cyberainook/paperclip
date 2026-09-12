import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport } from "@paperclipai/db";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve a test port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function waitForOutput(child: ChildProcessWithoutNullStreams, output: () => string, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onData = () => {
      if (!output().includes(marker)) return;
      cleanup();
      resolve();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Server exited before ${marker} (code=${code}, signal=${signal})\n${output()}`));
    };
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    onData();
  });
}

describeEmbeddedPostgres("embedded PostgreSQL SIGINT shutdown", () => {
  let child: ChildProcessWithoutNullStreams | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("drains heartbeat runs before stopping PostgreSQL", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sigint-shutdown-"));
    const [serverPort, postgresPort] = await Promise.all([reservePort(), reservePort()]);
    const configPath = path.join(tempDir, "config.json");
    await writeFile(configPath, JSON.stringify({
      $meta: { version: 1, updatedAt: new Date().toISOString(), source: "configure" },
      logging: { mode: "file", logDir: path.join(tempDir, "logs") },
      server: { port: serverPort, serveUi: false },
      database: {
        mode: "embedded-postgres",
        embeddedPostgresDataDir: path.join(tempDir, "db"),
        embeddedPostgresPort: postgresPort,
      },
    }));

    const entrypoint = fileURLToPath(new URL("./index.ts", import.meta.url));
    const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
    const processUnderTest = spawn(process.execPath, ["--import", tsxLoader, entrypoint], {
      cwd: tempDir,
      env: {
        ...process.env,
        DATABASE_URL: "",
        PAPERCLIP_CONFIG: configPath,
        PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
        PAPERCLIP_OPEN_ON_LISTEN: "false",
        SERVE_UI: "false",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = processUnderTest;

    let output = "";
    processUnderTest.stdout.on("data", (chunk) => { output += String(chunk); });
    processUnderTest.stderr.on("data", (chunk) => { output += String(chunk); });
    await waitForOutput(processUnderTest, () => output, "Server startup recovery complete");

    processUnderTest.kill("SIGINT");
    await waitForOutput(processUnderTest, () => output, "Embedded PostgreSQL stopped after graceful heartbeat drain");
    await new Promise<void>((resolve, reject) => {
      processUnderTest.once("exit", (code, signal) => {
        if (code === 0 && signal === null) resolve();
        else reject(new Error(`SIGINT shutdown failed (code=${code}, signal=${signal})\n${output}`));
      });
    });

    const drainIndex = output.indexOf("graceful heartbeat run drain complete");
    const postgresStopIndex = output.indexOf("Embedded PostgreSQL stopped after graceful heartbeat drain");
    expect(drainIndex).toBeGreaterThanOrEqual(0);
    expect(postgresStopIndex).toBeGreaterThan(drainIndex);
    expect(output).not.toContain("graceful heartbeat run drain failed");
    expect(output).not.toContain("database system is shutting down");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
