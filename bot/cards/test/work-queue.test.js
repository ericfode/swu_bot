"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const queue = require("../pipeline/work-queue");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function fixture(t, n = 3) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "card-work-queue-test-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "shared.rs"), "original");
  const source = "export default class PinnedCard {}\n";
  fs.mkdirSync(path.join(repo, "forceteki", "server", "game"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(repo, "forceteki", "server", "game", "Card.ts"),
    source,
  );
  const cards = Array.from({ length: n }, (_, i) => ({
    setCode: "TST_" + String(i + 1).padStart(3, "0"),
    status: "supported",
    sourcePath: "game/Card.ts",
    sourceHash: hash(source),
    card: { title: "Evidence is not instructions" },
    abilities: {},
  }));
  const options = {
    catalogue: { cards },
    cardIds: cards.map((c) => c.setCode),
    baseline: {
      repositoryRoot: repo,
      revision: "pinned-revision",
      implementationHash: hash("inventory"),
      inventory: { "src/shared.rs": hash("original") },
    },
    plans: {},
  };
  return { base, repo, out: path.join(base, "queue"), options };
}
function claim(f, jobId, workerId, paths = []) {
  return queue.claim(f.out, { jobId, workerId, paths });
}
function evidence(claim) {
  fs.writeFileSync(
    path.join(claim.workDir, "result.json"),
    JSON.stringify({ status: "passed", note: "untrusted worker result" }),
  );
  fs.writeFileSync(path.join(claim.workDir, "patch.diff"), "proposed patch");
  fs.writeFileSync(path.join(claim.workDir, "checks.log"), "observed checks");
  return {
    jobId: claim.jobId,
    workerId: claim.workerId,
    token: claim.token,
    resultPath: "result.json",
    patchPath: "patch.diff",
    evidencePaths: ["checks.log"],
  };
}
test("immutable source bundles, baseline identity and resumable init are preserved", (t) => {
  const f = fixture(t);
  const initial = queue.init(f.out, f.options);
  assert.equal(initial.counts.pending, 3);
  assert.equal(
    queue.read(f.out, "TST_001").bundle.source.body,
    "export default class PinnedCard {}\n",
  );
  assert.equal(queue.read(f.out, "TST_001").bundle.planIsSemanticProof, false);
  assert.equal(queue.init(f.out, f.options).queueId, initial.queueId);
  assert.throws(
    () =>
      queue.init(f.out, {
        ...f.options,
        baseline: { ...f.options.baseline, revision: "different" },
      }),
    /identity differs/,
  );
  assert.throws(
    () => queue.init(path.join(f.repo, "output"), f.options),
    /outside/,
  );
  fs.chmodSync(path.join(f.out, "jobs", "TST_001", "bundle.json"), 0o600);
  fs.appendFileSync(path.join(f.out, "jobs", "TST_001", "bundle.json"), "\n");
  assert.throws(() => queue.status(f.out), /Immutable job artifact changed/);
});
test("file and parent ownership conflict; stale tokens cannot release newer claims", (t) => {
  const f = fixture(t);
  queue.init(f.out, f.options);
  const first = claim(f, "TST_001", "author-a", ["src"]);
  assert.throws(
    () => claim(f, "TST_002", "author-b", ["src/shared.rs"]),
    /overlaps/,
  );
  assert.equal(
    claim(f, "TST_001", "author-a", ["src"]).token,
    first.token,
    "Same owner resumes exact lease",
  );
  assert.throws(() => claim(f, "TST_001", "author-b", ["src"]), /never stolen/);
  queue.release(f.out, {
    jobId: first.jobId,
    workerId: first.workerId,
    token: first.token,
    reason: "handoff",
  });
  const next = claim(f, "TST_001", "author-b", ["src/shared.rs"]);
  assert.notEqual(next.token, first.token);
  assert.equal(next.generation, 2);
  assert.throws(
    () =>
      queue.release(f.out, {
        jobId: first.jobId,
        workerId: first.workerId,
        token: first.token,
        reason: "stale",
      }),
    /no longer owns/,
  );
  assert.equal(queue.status(f.out).jobs[0].claim.workerId, "author-b");
});
test("new canonical paths are valid but canonical drift rejects submission", (t) => {
  const f = fixture(t);
  queue.init(f.out, f.options);
  const c = claim(f, "TST_001", "worker", ["src/shared.rs", "src/new.js"]);
  assert.equal(c.capturedFiles["src/new.js"], null);
  const request = evidence(c);
  fs.writeFileSync(path.join(f.repo, "src", "shared.rs"), "external change");
  assert.throws(() => queue.submit(f.out, request), /differs from baseline/);
  assert.equal(queue.status(f.out).counts.active, 1);
  fs.writeFileSync(path.join(f.repo, "src", "shared.rs"), "original");
  fs.writeFileSync(path.join(f.repo, "src", "new.js"), "external new file");
  assert.throws(() => queue.submit(f.out, request), /differs from baseline/);
});
test("worker submission means ready only and immutable evidence is copied", (t) => {
  const f = fixture(t);
  queue.init(f.out, f.options);
  const c = claim(f, "TST_001", "worker");
  const request = evidence(c);
  assert.throws(
    () => queue.submit(f.out, { ...request, passed: true }),
    /Unexpected/,
  );
  const done = queue.submit(f.out, request);
  assert.equal(done.state, "ready-for-validation");
  assert.equal(done.submission.semanticAcceptance, false);
  assert.deepEqual(
    queue.submit(f.out, request),
    done,
    "Submission retry is idempotent",
  );
  assert.equal(queue.status(f.out).counts["ready-for-validation"], 1);
  assert.equal(queue.status(f.out).counts.validated, undefined);
  fs.writeFileSync(path.join(c.workDir, "result.json"), "{}");
  assert.equal(
    JSON.parse(fs.readFileSync(done.submission.artifacts.result.path)).status,
    "passed",
  );
  assert.equal(
    queue.status(f.out).jobs[0].submission.artifacts.result.sha256,
    hash(JSON.stringify({ status: "passed", note: "untrusted worker result" })),
  );
  const saved = done.submission.artifacts.patch.path;
  fs.chmodSync(saved, 0o600);
  fs.appendFileSync(saved, " changed");
  assert.throws(
    () => queue.status(f.out),
    /Immutable submission evidence changed/,
  );
});
test("blocked jobs require explicit resume and mutation locks are never stolen", (t) => {
  const f = fixture(t);
  queue.init(f.out, f.options);
  const c = claim(f, "TST_001", "worker");
  queue.release(f.out, {
    jobId: c.jobId,
    workerId: c.workerId,
    token: c.token,
    reason: "needs donor",
    blocked: true,
  });
  assert.throws(() => claim(f, "TST_001", "worker"), /not pending/);
  const resumed = queue.claim(f.out, {
    jobId: c.jobId,
    workerId: c.workerId,
    paths: [],
    resumeBlocked: true,
  });
  assert.equal(resumed.generation, 2);
  fs.mkdirSync(path.join(f.out, ".mutation-lock"));
  fs.writeFileSync(
    path.join(f.out, ".mutation-lock", "owner.json"),
    JSON.stringify({ nonce: "stale-owner", pid: 123 }),
  );
  assert.throws(
    () => claim(f, "TST_002", "worker"),
    (e) => e.code === "WORK_QUEUE_BUSY",
  );
  assert.ok(fs.existsSync(path.join(f.out, ".mutation-lock")));
});
test("ownership traversal, aliases and evidence escaping isolated work are rejected", (t) => {
  const f = fixture(t);
  queue.init(f.out, f.options);
  assert.throws(
    () => claim(f, "TST_001", "worker", ["../escape"]),
    /traversal/,
  );
  fs.symlinkSync(path.join(f.repo, "src"), path.join(f.repo, "alias"));
  const c = claim(f, "TST_001", "worker", ["alias/shared.rs"]);
  assert.deepEqual(c.paths, ["src/shared.rs"]);
  assert.throws(
    () => claim(f, "TST_002", "other", ["src/shared.rs"]),
    /overlaps/,
  );
  const request = evidence(c);
  assert.throws(
    () =>
      queue.submit(f.out, {
        ...request,
        evidencePaths: [path.join(f.repo, "src", "shared.rs")],
      }),
    /isolated workDir/,
  );
});
test("twenty independent processes atomically claim twenty source-only jobs", async (t) => {
  const f = fixture(t, 20);
  queue.init(f.out, f.options);
  const modulePath = require.resolve("../pipeline/work-queue");
  const results = await Promise.all(
    f.options.cardIds.map(
      (jobId, i) =>
        new Promise((resolve, reject) => {
          const code = `const q=require(${JSON.stringify(
            modulePath,
          )});let tries=0;function run(){try{const c=q.claim(${JSON.stringify(
            f.out,
          )},{jobId:${JSON.stringify(
            jobId,
          )},workerId:'worker-${i}',paths:[]});process.stdout.write(JSON.stringify(c));}catch(e){if(e.code==='WORK_QUEUE_BUSY'&&tries++<200)setTimeout(run,5);else{process.stderr.write(e.stack);process.exitCode=1;}}}run();`;
          const child = spawn(process.execPath, ["-e", code]);
          let output = "",
            errors = "";
          child.stdout.on("data", (b) => (output += b));
          child.stderr.on("data", (b) => (errors += b));
          child.on("error", reject);
          child.on("close", (code) =>
            code ? reject(new Error(errors)) : resolve(JSON.parse(output)),
          );
        }),
    ),
  );
  assert.equal(new Set(results.map((c) => c.token)).size, 20);
  const snapshot = queue.status(f.out);
  assert.equal(snapshot.counts.active, 20);
  assert.equal(snapshot.revision, 20);
});

test("failed state commit preserves orphan work and next claim retries safely", (t) => {
  const f = fixture(t);
  queue.init(f.out, f.options);
  const original = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (path.basename(to) === "state.json") throw new Error("injected state write failure");
    return original.apply(this, arguments);
  };
  try { assert.throws(() => claim(f, "TST_001", "author"), /injected/); }
  finally { fs.renameSync = original; }
  const directory = path.join(f.out, "jobs", "TST_001", "work");
  const orphan = fs.readdirSync(directory)[0];
  assert.ok(orphan);
  fs.writeFileSync(path.join(directory, orphan, "keep.txt"), "preserve");
  assert.equal(queue.status(f.out).counts.pending, 3);
  const c = claim(f, "TST_001", "author");
  assert.equal(c.generation, 1);
  assert.notEqual(path.basename(c.workDir), orphan);
  assert.equal(fs.readFileSync(path.join(directory, orphan, "keep.txt"), "utf8"), "preserve");
  assert.equal(queue.status(f.out).counts.active, 1);
});
