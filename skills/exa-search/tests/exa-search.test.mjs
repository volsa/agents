import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../scripts/exa-search.mjs";

const script = fileURLToPath(new URL("../scripts/exa-search.mjs", import.meta.url));

async function run(args, env = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => stdout += chunk);
  child.stderr.on("data", chunk => stderr += chunk);
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

async function server(response) {
  const requests = [];
  const instance = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ headers: req.headers, body: JSON.parse(body) });
    res.writeHead(response.status, { "content-type": response.contentType || "application/json" });
    res.end(typeof response.body === "string" ? response.body : JSON.stringify(response.body));
  });
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  return {
    instance,
    requests,
    url: `http://127.0.0.1:${instance.address().port}/search`,
  };
}

test("builds a common search request", async () => {
  const { body } = await parseArgs([
    "--type", "deep", "-n", "7", "--highlights", "--include-domain", "example.com",
    "--additional-query", "independent evidence", "a", "natural", "query",
  ]);
  assert.deepEqual(body, {
    type: "deep",
    numResults: 7,
    contents: { highlights: true },
    includeDomains: ["example.com"],
    additionalQueries: ["independent evidence"],
    query: "a natural query",
  });
});

test("missing key is an explicit error", async () => {
  const result = await run(["test query"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /EXA_API_KEY is missing from the environment/);
});

test("sends key without printing it and emits successful JSON", async t => {
  const mock = await server({ status: 200, body: { requestId: "ok", results: [] } });
  t.after(() => mock.instance.close());
  const result = await run(["--highlights", "test query"], {
    EXA_API_KEY: "secret-test-key",
    EXA_API_URL: mock.url,
  });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).requestId, "ok");
  assert.equal(mock.requests[0].headers.authorization, "Bearer secret-test-key");
  assert.deepEqual(mock.requests[0].body, { contents: { highlights: true }, query: "test query" });
  assert.doesNotMatch(result.stdout + result.stderr, /secret-test-key/);
});

test("classifies rejected keys", async t => {
  const mock = await server({
    status: 401,
    body: { requestId: "req-1", error: "Invalid API key bad-key", tag: "INVALID_API_KEY" },
  });
  t.after(() => mock.instance.close());
  const result = await run(["test query"], { EXA_API_KEY: "bad-key", EXA_API_URL: mock.url });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /invalid, expired, revoked/);
  assert.match(result.stderr, /INVALID_API_KEY/);
  assert.match(result.stderr, /req-1/);
  assert.doesNotMatch(result.stderr, /bad-key/);
});

test("classifies exhausted credits", async t => {
  const mock = await server({
    status: 402,
    body: { requestId: "req-2", error: "No credits", tag: "NO_MORE_CREDITS" },
  });
  t.after(() => mock.instance.close());
  const result = await run(["test query"], { EXA_API_KEY: "key", EXA_API_URL: mock.url });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no available credits/);
});
