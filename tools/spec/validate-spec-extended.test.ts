import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSourceFiles } from "./validate-spec.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
	const dir = join(tmpdir(), `validate-spec-extended-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// ---------------------------------------------------------------------------
// readSourceFiles — static import is fine (module has no side effects at
// import time except the isMain guard, which won't fire with vitest argv).
// ---------------------------------------------------------------------------

describe("readSourceFiles", () => {
	let tmpDir: string | undefined;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty map for non-existent directory", () => {
		const result = readSourceFiles("/tmp/this-path-does-not-exist-xyz");
		expect(result.size).toBe(0);
		expect(result).toBeInstanceOf(Map);
	});

	it("reads .ts files from directory", () => {
		writeFileSync(join(tmpDir!, "dht.ts"), 'const key = "/bpb/v2/test";');
		writeFileSync(join(tmpDir!, "bootstrap.ts"), "export default {};");

		const result = readSourceFiles(tmpDir!);
		expect(result.size).toBe(2);
		expect(result.get("dht.ts")).toBe('const key = "/bpb/v2/test";');
		expect(result.get("bootstrap.ts")).toBe("export default {};");
	});

	it("ignores non-.ts files", () => {
		writeFileSync(join(tmpDir!, "dht.ts"), "const x = 1;");
		writeFileSync(join(tmpDir!, "readme.md"), "# Hello");
		writeFileSync(join(tmpDir!, "config.json"), "{}");
		writeFileSync(join(tmpDir!, ".gitignore"), "node_modules");

		const result = readSourceFiles(tmpDir!);
		expect(result.size).toBe(1);
		expect(result.has("dht.ts")).toBe(true);
		expect(result.has("readme.md")).toBe(false);
		expect(result.has("config.json")).toBe(false);
		expect(result.has(".gitignore")).toBe(false);
	});

	it("reads nested files", () => {
		const nestedDir = join(tmpDir!, "nested");
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(
			join(nestedDir, "announce.ts"),
			"export const announce = true;",
		);

		const result = readSourceFiles(tmpDir!);
		// readdirSync is non-recursive, so nested files are NOT included
		expect(result.size).toBe(0);
	});

	it("handles empty directory", () => {
		const result = readSourceFiles(tmpDir!);
		expect(result.size).toBe(0);
		expect(result).toBeInstanceOf(Map);
	});
});

// ---------------------------------------------------------------------------
// main — tested via vi.importActual so the isMain guard fires with our
// custom process.argv. vi.resetModules() ensures the module body re-executes.
// ---------------------------------------------------------------------------

describe("main", () => {
	let tmpDir: string | undefined;
	let origArgv: string[];
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tmpDir = createTempDir();
		origArgv = [...process.argv];
		exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		process.argv = origArgv;
		exitSpy.mockRestore();
		errorSpy.mockRestore();
		logSpy.mockRestore();
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	it("exits 2 when spec file not found", async () => {
		const srcDir = join(tmpDir!, "src");
		mkdirSync(srcDir, { recursive: true });

		process.argv = [
			"node",
			"validate-spec.ts",
			"--spec",
			"/tmp/nonexistent-spec-file-xyz.md",
			"--src",
			srcDir,
		];

		vi.resetModules();
		await vi.importActual("./validate-spec.ts");

		expect(exitSpy).toHaveBeenCalledWith(2);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Spec file not found"),
		);
	});

	it("exits 1 when drift detected", async () => {
		const specPath = join(tmpDir!, "SPEC-V2-MESH.md");
		writeFileSync(specPath, "# Spec\n\n/bpb/v2/ prefix required.");
		const srcDir = join(tmpDir!, "src");
		mkdirSync(srcDir, { recursive: true });
		// Write source that fails most checks (no /bpb/v2/, no tombstone, no fields)
		writeFileSync(join(srcDir, "dht.ts"), "// nothing relevant here");

		process.argv = [
			"node",
			"validate-spec.ts",
			"--spec",
			specPath,
			"--src",
			srcDir,
		];

		vi.resetModules();
		await vi.importActual("./validate-spec.ts");

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("Spec drift detected"),
		);
	});

	it("exits 0 when no drift", async () => {
		const specPath = join(tmpDir!, "SPEC-V2-MESH.md");
		writeFileSync(specPath, "# Spec\n\n/bpb/v2/ prefix required.");
		const srcDir = join(tmpDir!, "src");
		mkdirSync(srcDir, { recursive: true });
		// Write source that passes all checks
		writeFileSync(
			join(srcDir, "dht.ts"),
			[
				'const key = "/bpb/v2/test";',
				"const TOMBSTONE = '/bpb/v2/tombstone';",
				"const peerId = 'abc'; const protocol = 'vless'; const host = 'example.com';",
				"const port = 443; const ttl = uniform(15, 60); const bornAt = Date.now();",
				"const expiresAt = bornAt + 3600;",
			].join("\n"),
		);

		process.argv = [
			"node",
			"validate-spec.ts",
			"--spec",
			specPath,
			"--src",
			srcDir,
		];

		vi.resetModules();
		await vi.importActual("./validate-spec.ts");

		expect(exitSpy).toHaveBeenCalledWith(0);
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("No spec drift detected"),
		);
	});

	it("prints warning when no .ts files found", async () => {
		const specPath = join(tmpDir!, "SPEC-V2-MESH.md");
		writeFileSync(specPath, "# Spec\n\n/bpb/v2/ prefix required.");
		const srcDir = join(tmpDir!, "empty-src");
		mkdirSync(srcDir, { recursive: true });
		// No .ts files in srcDir

		process.argv = [
			"node",
			"validate-spec.ts",
			"--spec",
			specPath,
			"--src",
			srcDir,
		];

		vi.resetModules();
		await vi.importActual("./validate-spec.ts");

		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("No TypeScript source files found"),
		);
	});
});
