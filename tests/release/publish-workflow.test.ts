import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const scripts = path.join(root, ".github", "scripts");
const workflow = read(".github", "workflows", "publish.yml");
const release = read(".github", "scripts", "npm-release.sh");
const wait = read(".github", "scripts", "wait-for-npm.sh");

const posix = process.platform !== "win32";
// The scripts run on ubuntu-latest, which has jq. Elsewhere the runs that need it are skipped.
const canRun = posix && spawnSync("jq", ["--version"]).status === 0;

const NAME = "some-pkg";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

/**
 * A fake npm registry in a folder, with `npm` and `curl` stubs in front of it
 * on PATH. Files hold the state: `versions` (one per line), `tag.<name>`,
 * `githead`. Files named in `knobs` switch on a failure:
 *   refuse-dist-tag   `npm dist-tag add` and `rm` are refused
 *   refuse-rm         only `npm dist-tag rm` is refused
 *   swallow-dist-tag  `npm dist-tag add` succeeds but the tag never shows
 *   view-broken       `npm view` fails with something other than E404
 *   tarball-code      the status the tarball URL answers (default 200)
 *   latest-after-wait a version that becomes `latest` while the tarball wait runs
 */
const FAKE_NPM = `#!/bin/sh
S="$FAKE_STATE"
echo "npm $*" >> "$S/log"
not_found() { echo "npm error code E404" >&2; exit 1; }
refused() { echo "npm error code E403" >&2; exit 1; }
case "$1" in
  view)
    [ -f "$S/view-broken" ] && { echo "npm error code ETIMEDOUT" >&2; exit 1; }
    case "$2" in
      *@*)
        grep -qx "\${2##*@}" "$S/versions" 2>/dev/null || not_found
        case "$3" in
          version) echo "\${2##*@}" ;;
          gitHead) cat "$S/githead" 2>/dev/null || true ;;
        esac ;;
      *)
        [ -s "$S/versions" ] || not_found
        case "$3" in
          version) cat "$S/tag.latest" ;;
          dist-tags.*) cat "$S/tag.\${3#dist-tags.}" 2>/dev/null || true ;;
        esac ;;
    esac ;;
  publish)
    for last; do :; done
    cat "$S/package-version" >> "$S/versions"
    cp "$S/package-version" "$S/tag.$last"
    echo "$GITHUB_SHA" > "$S/githead" ;;
  dist-tag)
    [ -f "$S/refuse-dist-tag" ] && refused
    case "$2" in
      add) [ -f "$S/swallow-dist-tag" ] || echo "\${3##*@}" > "$S/tag.$4" ;;
      rm) [ -f "$S/refuse-rm" ] && refused; rm -f "$S/tag.$4" ;;
    esac ;;
esac
`;

const FAKE_CURL = `#!/bin/sh
S="$FAKE_STATE"
case "$*" in
  *http_code*)
    [ -f "$S/latest-after-wait" ] && cp "$S/latest-after-wait" "$S/tag.latest"
    printf '%s' "$(cat "$S/tarball-code" 2>/dev/null || echo 200)" ;;
  *)
    for last; do :; done
    grep -qx "\${last##*/}" "$S/versions" 2>/dev/null && echo '{"dist":{"tarball":"https://registry.example/pkg.tgz"}}' ;;
esac
`;

interface Registry {
  /** Versions npm has, oldest first. */
  versions?: string[];
  latest?: string;
  staged?: string;
  /** The commit npm recorded for the version in package.json. */
  gitHead?: string;
  knobs?: Record<string, string>;
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeRegistry(registry: Registry) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-npm-"));
  made.push(dir);
  const state = path.join(dir, "state");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(state);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "npm"), FAKE_NPM, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
  const put = (file: string, value: string) => fs.writeFileSync(path.join(state, file), `${value}\n`);
  if (registry.versions?.length) put("versions", registry.versions.join("\n"));
  if (registry.latest) put("tag.latest", registry.latest);
  if (registry.staged) put("tag.staged", registry.staged);
  if (registry.gitHead) put("githead", registry.gitHead);
  for (const [knob, value] of Object.entries(registry.knobs ?? {})) put(knob, value);

  const tag = (name: string) => {
    const file = path.join(state, `tag.${name}`);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : undefined;
  };

  /** Runs npm-release.sh as the workflow run of `sha` for `version`. */
  const run = (version: string, sha = SHA) => {
    const repo = fs.mkdtempSync(path.join(dir, "repo-"));
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: NAME, version }));
    put("package-version", version);
    const output = path.join(repo, "github-output");
    const logFile = path.join(state, "log");
    fs.rmSync(logFile, { force: true });
    const result = spawnSync("bash", [path.join(scripts, "npm-release.sh")], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_STATE: state,
        GITHUB_OUTPUT: output,
        GITHUB_SHA: sha,
        NPM_WAIT_ATTEMPTS: "3",
        NPM_WAIT_INTERVAL: "0",
        NPM_VERIFY_ATTEMPTS: "3",
        NPM_VERIFY_INTERVAL: "0",
      },
    });
    const outputs = Object.fromEntries(
      (fs.existsSync(output) ? fs.readFileSync(output, "utf8") : "").split("\n").filter(Boolean).map((line) => line.split("=")),
    );
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    return {
      status: result.status,
      text: result.stdout + result.stderr,
      published: outputs.published as string | undefined,
      version: outputs.version as string | undefined,
      /** Every npm command that changes the registry, in order. */
      writes: log.split("\n").filter((line) => /^npm (publish|dist-tag)/.test(line)),
    };
  };

  return { run, tag, knob: (name: string, value = "1") => put(name, value), unknob: (name: string) => fs.rmSync(path.join(state, name), { force: true }) };
}

const PUBLISH_STAGED = "npm publish --provenance --access public --tag staged";
const PROMOTE = (version: string) => `npm dist-tag add ${NAME}@${version} latest`;
const UNSTAGE = `npm dist-tag rm ${NAME} staged`;

describe("publish workflow", () => {
  it("runs one publish at a time and never cancels one in progress", () => {
    // Two merges once published concurrently and the older version finished last,
    // leaving npm's `latest` on it.
    expect(workflow).toMatch(/^concurrency:\n  group: publish-npm\n  cancel-in-progress: false$/m);
  });

  it("leaves every npm decision to npm-release.sh", () => {
    const step = workflow.slice(workflow.indexOf("- name: Publish if version changed"), workflow.indexOf("# Tags the commit"));
    expect(step).toContain("id: publish");
    expect(step).toContain("run: bash .github/scripts/npm-release.sh");
    expect(step).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(workflow).not.toMatch(/^\s*npm (publish|dist-tag)\b/m);
  });

  it("does not move the publish triggers or the release rule", () => {
    expect(workflow).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]$/m);
    expect(workflow).toMatch(/github-release:\n {4}needs: publish\n {4}if: needs\.publish\.outputs\.published == 'true'/);
    expect(workflow).toMatch(/registry:\n {4}needs: publish\n {4}if: needs\.publish\.outputs\.published == 'true'/);
  });
});

describe("npm-release.sh", () => {
  it("never publishes a version straight to latest", () => {
    const publishes = release.split("\n").filter((line) => /^\s*npm publish /.test(line));
    expect(publishes.map((line) => line.trim()).sort()).toEqual([
      'npm publish --provenance --access public --tag "$STAGED_TAG"',
      "npm publish --provenance --access public --tag next",
    ]);
    const staged = /^STAGED_TAG=(\S+)$/m.exec(release)?.[1];
    expect(staged).toBeTruthy();
    expect(["latest", "next"]).not.toContain(staged);
  });

  it("names the command that promotes by hand in every failure", () => {
    expect(release).toContain('PROMOTE_BY_HAND="npm dist-tag add $NAME@$CURRENT latest"');
    const errors = release.split("\n").filter((line) => line.includes("::error::") && !line.includes("npm view $1"));
    expect(errors).toHaveLength(3);
    for (const line of errors) expect(line).toContain("$PROMOTE_BY_HAND");
  });

  it.runIf(posix).each(["npm-release.sh", "wait-for-npm.sh"])("%s is valid bash", (file) => {
    const result = spawnSync("bash", ["-n", path.join(scripts, file)], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  describe("version comparison", () => {
    const newer = (a: string, b: string) =>
      execFileSync("node", [path.join(scripts, "semver-newer.mjs"), a, b], { encoding: "utf8" }).trim() === "true";

    it.each([
      ["5.1.43", "5.1.42", true],
      ["5.1.42", "5.1.43", false],
      ["5.1.43", "5.1.43", false],
      ["5.10.0", "5.9.9", true],
      ["5.2.0", "5.1.43", true],
      ["6.0.0", "5.99.99", true],
      ["5.1.43", "0.0.0", true],
    ])("compares %s with %s numerically: %s", (a, b, expected) => expect(newer(a, b)).toBe(expected));

    it.each([
      ["1.0.0", "1.0.0-rc.1", true],
      ["1.0.0-rc.1", "1.0.0", false],
      ["1.0.0-rc.2", "1.0.0-rc.1", true],
      ["1.0.0-rc.10", "1.0.0-rc.2", true],
      ["1.0.0-beta", "1.0.0-alpha", true],
      ["1.0.0-alpha.1", "1.0.0-alpha", true],
      ["1.0.0-alpha", "1.0.0-alpha.1", false],
      ["1.0.0-1", "1.0.0-alpha", false],
      ["1.0.0-alpha", "1.0.0-1", true],
      ["1.0.0-rc.1", "1.0.0-rc.1", false],
      ["5.3.0-beta.1", "5.2.0", true],
      ["1.0.0+build.5", "1.0.0", false],
    ])("follows semver precedence for prereleases: %s vs %s", (a, b, expected) => expect(newer(a, b)).toBe(expected));
  });

  describe.runIf(posix)("reading npm's answer", () => {
    const fn = /(npm_view\(\) \{[\s\S]*?\n\})/.exec(release)?.[1];

    const ask = (npmBody: string) => {
      const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-npm-"));
      try {
        fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\n${npmBody}\n`, { mode: 0o755 });
        const result = spawnSync("bash", ["-c", `${fn}\nnpm_view some-pkg version; echo "[rc=$?]"`], {
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        });
        return { out: result.stdout, err: result.stderr };
      } finally {
        fs.rmSync(bin, { recursive: true, force: true });
      }
    };

    it("is present", () => expect(fn).toBeTruthy());

    it("returns the version npm reports", () => {
      expect(ask('echo "5.1.43"').out).toBe("5.1.43[rc=0]\n");
    });

    it("keeps an npm warning on stderr out of the version it returns", () => {
      const { out, err } = ask('echo "npm warn config something is deprecated" >&2; echo "5.1.43"');
      expect(out).toBe("5.1.43[rc=0]\n");
      expect(err).toBe("");
    });

    it("treats E404 as never published: empty answer, success", () => {
      expect(ask('echo "npm error code E404" >&2; exit 1').out).toBe("[rc=0]\n");
    });

    it("fails hard on any other npm failure instead of falling back to 0.0.0", () => {
      const { out, err } = ask('echo "npm error code ETIMEDOUT" >&2; exit 1');
      expect(out).toBe("[rc=1]\n");
      expect(err).toContain("::error::npm view some-pkg version failed");
    });
  });

  // Each case runs the real script against a fake registry: no network.
  describe.runIf(canRun)("what it does to npm", () => {
    const released = { versions: ["5.2.18"], latest: "5.2.18" };

    it("publishes a new stable version as staged, waits for the tarball, then moves latest and drops staged", () => {
      const npm = fakeRegistry(released);
      const result = npm.run("5.2.19");
      expect(result.status).toBe(0);
      expect(result.writes).toEqual([PUBLISH_STAGED, PROMOTE("5.2.19"), UNSTAGE]);
      expect(result.text).toContain("npm serves some-pkg@5.2.19 and its tarball");
      expect(result).toMatchObject({ published: "true", version: "5.2.19" });
      expect(npm.tag("latest")).toBe("5.2.19");
      expect(npm.tag("staged")).toBeUndefined();
    });

    it("leaves latest alone and fails, naming the state and the command, when the tarball never downloads", () => {
      const npm = fakeRegistry({ ...released, knobs: { "tarball-code": "404" } });
      const result = npm.run("5.2.19");
      expect(result.status).toBe(1);
      expect(result.writes).toEqual([PUBLISH_STAGED]);
      expect(result.published).toBeUndefined();
      expect(npm.tag("latest")).toBe("5.2.18");
      expect(npm.tag("staged")).toBe("5.2.19");
      expect(result.text).toContain("::error::npm never served the tarball of some-pkg@5.2.19");
      expect(result.text).toContain("`latest` is still 5.2.18");
      expect(result.text).toContain("are unaffected");
      expect(result.text).toContain(PROMOTE("5.2.19"));
    });

    it("promotes on a re-run a version that is on npm but never became latest, without publishing again", () => {
      const npm = fakeRegistry({ ...released, knobs: { "tarball-code": "404" } });
      expect(npm.run("5.2.19").status).toBe(1);
      npm.knob("tarball-code", "200");
      const rerun = npm.run("5.2.19");
      expect(rerun.status).toBe(0);
      expect(rerun.writes).toEqual([PROMOTE("5.2.19"), UNSTAGE]);
      expect(rerun.published).toBe("true");
      expect(npm.tag("latest")).toBe("5.2.19");
    });

    it("fails, naming the state and the command, when npm refuses to move latest", () => {
      const npm = fakeRegistry({ ...released, knobs: { "refuse-dist-tag": "1" } });
      const result = npm.run("5.2.19");
      expect(result.status).toBe(1);
      expect(result.writes).toEqual([PUBLISH_STAGED, PROMOTE("5.2.19")]);
      expect(result.published).toBeUndefined();
      expect(npm.tag("latest")).toBe("5.2.18");
      expect(result.text).toContain("::error::npm refused to move `latest` to some-pkg@5.2.19");
      expect(result.text).toContain("`latest` is still 5.2.18");
      expect(result.text).toContain("are unaffected");
      expect(result.text).toContain(PROMOTE("5.2.19"));
    });

    it("finishes the release on a re-run after latest was moved by hand, even if staged cannot be removed", () => {
      const npm = fakeRegistry({ versions: ["5.2.18", "5.2.19"], latest: "5.2.19", staged: "5.2.19", gitHead: SHA, knobs: { "refuse-dist-tag": "1" } });
      const result = npm.run("5.2.19");
      expect(result.status).toBe(0);
      expect(result.writes).toEqual([UNSTAGE]);
      expect(result.published).toBe("true");
      expect(result.text).toContain("::warning::");
      expect(result.text).toContain(UNSTAGE);
    });

    it("skips a version whose release is finished: latest, and no staged tag", () => {
      const npm = fakeRegistry(released);
      const result = npm.run("5.2.18");
      expect(result.status).toBe(0);
      expect(result.writes).toEqual([]);
      expect(result.published).toBe("false");
    });

    it("skips a full re-run of a release it already finished", () => {
      const npm = fakeRegistry(released);
      expect(npm.run("5.2.19").published).toBe("true");
      const rerun = npm.run("5.2.19");
      expect(rerun.writes).toEqual([]);
      expect(rerun.published).toBe("false");
    });

    it("neither publishes nor promotes a version older than latest", () => {
      for (const versions of [["5.2.18", "5.2.19"], ["5.2.19"]]) {
        const npm = fakeRegistry({ versions, latest: "5.2.19", gitHead: SHA });
        const result = npm.run("5.2.18");
        expect(result.status).toBe(0);
        expect(result.writes).toEqual([]);
        expect(result.published).toBe("false");
        expect(npm.tag("latest")).toBe("5.2.19");
      }
    });

    it("does not move latest backwards when a newer version became latest during the wait", () => {
      const npm = fakeRegistry({ ...released, knobs: { "latest-after-wait": "5.2.20" } });
      const result = npm.run("5.2.19");
      expect(result.status).toBe(0);
      expect(result.writes).toEqual([PUBLISH_STAGED]);
      expect(result.published).toBe("false");
      expect(npm.tag("latest")).toBe("5.2.20");
      expect(result.text).toContain("::warning::some-pkg@5.2.19 was not promoted");
    });

    it("fails without dropping staged when npm accepts the move but never shows it, and a re-run recovers", () => {
      const npm = fakeRegistry({ ...released, knobs: { "swallow-dist-tag": "1" } });
      const result = npm.run("5.2.19");
      expect(result.status).toBe(1);
      expect(result.writes).toEqual([PUBLISH_STAGED, PROMOTE("5.2.19")]);
      expect(result.published).toBeUndefined();
      expect(npm.tag("staged")).toBe("5.2.19");
      expect(result.text).toContain("::error::npm accepted the move");
      npm.unknob("swallow-dist-tag");
      const rerun = npm.run("5.2.19");
      expect(rerun.writes).toEqual([PROMOTE("5.2.19"), UNSTAGE]);
      expect(rerun.published).toBe("true");
    });

    it("does not fail the release when only removing staged fails", () => {
      const npm = fakeRegistry({ ...released, knobs: { "refuse-rm": "1" } });
      const result = npm.run("5.2.19");
      expect(result.status).toBe(0);
      expect(result.published).toBe("true");
      expect(npm.tag("latest")).toBe("5.2.19");
      expect(result.text).toContain("::warning::");
      expect(result.text).toContain(UNSTAGE);
    });

    it("leaves an unfinished release to the run of the commit it was published from", () => {
      const stuck = fakeRegistry({ versions: ["5.2.18", "5.2.19"], latest: "5.2.18", staged: "5.2.19", gitHead: OTHER_SHA });
      const handPromoted = fakeRegistry({ versions: ["5.2.18", "5.2.19"], latest: "5.2.19", staged: "5.2.19", gitHead: OTHER_SHA });
      for (const npm of [stuck, handPromoted]) {
        const result = npm.run("5.2.19");
        expect(result.status).toBe(0);
        expect(result.writes).toEqual([]);
        expect(result.published).toBe("false");
        expect(result.text).toContain(`::warning::some-pkg@5.2.19 is on npm but its release is not finished`);
        expect(result.text).toContain(OTHER_SHA);
      }
    });

    it("publishes a prerelease under next and never touches latest", () => {
      const npm = fakeRegistry(released);
      const result = npm.run("5.3.0-beta.1");
      expect(result.status).toBe(0);
      expect(result.writes).toEqual(["npm publish --provenance --access public --tag next"]);
      expect(result.published).toBe("true");
      expect(npm.tag("latest")).toBe("5.2.18");
      const rerun = npm.run("5.3.0-beta.1");
      expect(rerun.writes).toEqual([]);
      expect(rerun.published).toBe("false");
    });

    it("stops before publishing when npm cannot be read", () => {
      const npm = fakeRegistry({ ...released, knobs: { "view-broken": "1" } });
      const result = npm.run("5.2.19");
      expect(result.status).toBe(1);
      expect(result.writes).toEqual([]);
      expect(result.text).toContain("::error::npm view some-pkg version failed");
    });
  });
});

describe("waiting for npm to serve a version", () => {
  it("needs both the version's metadata and a 200 from its tarball URL", () => {
    expect(wait).toContain("registry.npmjs.org");
    expect(wait).toContain(".dist.tarball");
    expect(wait).toContain("%{http_code}");
    expect(wait).toMatch(/= "200"/);
  });

  it("waits about 15 minutes, then exits 1", () => {
    const attempts = Number(/ATTEMPTS=\$\{NPM_WAIT_ATTEMPTS:-(\d+)\}/.exec(wait)?.[1]);
    const interval = Number(/INTERVAL=\$\{NPM_WAIT_INTERVAL:-(\d+)\}/.exec(wait)?.[1]);
    expect(attempts * interval).toBeGreaterThanOrEqual(14 * 60);
    expect(attempts * interval).toBeLessThanOrEqual(20 * 60);
    expect(wait.trimEnd().endsWith("exit 1")).toBe(true);
  });

  it("is what the registry job runs before mcp-publisher, and a timeout fails that job", () => {
    const start = workflow.indexOf("- name: Wait for the npm registry to serve the new version");
    const end = workflow.indexOf("- name: Install mcp-publisher");
    expect(start).toBeGreaterThan(workflow.indexOf("\n  registry:\n"));
    expect(end).toBeGreaterThan(start);
    const step = workflow.slice(start, end);
    expect(step).toContain('if ! bash .github/scripts/wait-for-npm.sh "$NAME" "$VERSION"; then');
    expect(step).toContain("::error::");
    expect(step).not.toContain("::warning::");
    expect(step).toMatch(/exit 1/);
  });
});
