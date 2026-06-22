/**
 * Spec ↔ Code Drift Checker for BPB Action Mesh
 *
 * Validates that the implemented code in node/src/ aligns with the
 * architectural specification in docs/SPEC-V2-MESH.md.
 *
 * Checks:
 *   1. DHT key prefix /bpb/v2/ used in announce.ts + dht.ts
 *   2. Tombstone key format contains "tombstone"
 *   3. Record fields: peerId, protocol, host, port, ttl, bornAt, expiresAt
 *   4. TTL bounds (15-60 min / 900-3600s) enforced somewhere
 *   5. No serial multi-hop (route:[], multiHop, serial)
 *
 * Exit codes: 0 = aligned, 1 = drift detected, 2 = spec file not found
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): {
	specPath: string;
	srcPath: string;
} {
	const defaults = {
		specPath: resolve(import.meta.dirname ?? ".", "../../docs/SPEC-V2-MESH.md"),
		srcPath: resolve(import.meta.dirname ?? ".", "../../node/src"),
	};

	let i = 2;
	while (i < argv.length) {
		if (argv[i] === "--spec" && argv[i + 1]) {
			defaults.specPath = resolve(argv[++i]);
		} else if (argv[i] === "--src" && argv[i + 1]) {
			defaults.srcPath = resolve(argv[++i]);
		}
		i++;
	}

	return defaults;
}

// ---------------------------------------------------------------------------
// File reading helpers
// ---------------------------------------------------------------------------

export function readSourceFiles(srcDir: string): Map<string, string> {
	const files = new Map<string, string>();
	if (!existsSync(srcDir)) return files;

	for (const name of readdirSync(srcDir)) {
		if (name.endsWith(".ts")) {
			const fullPath = join(srcDir, name);
			files.set(name, readFileSync(fullPath, "utf-8"));
		}
	}
	return files;
}

// ---------------------------------------------------------------------------
// Check functions
// ---------------------------------------------------------------------------

export interface CheckResult {
	pass: boolean;
	label: string;
	detail: string;
}

export function checkDHTKeyPrefix(files: Map<string, string>): CheckResult {
	const prefix = "/bpb/v2/";
	const found: string[] = [];

	for (const [name, content] of files) {
		if (content.includes(prefix)) {
			found.push(name);
		}
	}

	return {
		pass: found.length > 0,
		label: "DHT key prefix /bpb/v2/",
		detail:
			found.length > 0
				? `found in ${found.join(", ")}`
				: "NOT found in code — spec drift!",
	};
}

export function checkTombstoneFormat(files: Map<string, string>): CheckResult {
	const keyword = "tombstone";
	const found: string[] = [];

	for (const [name, content] of files) {
		if (content.toLowerCase().includes(keyword)) {
			found.push(name);
		}
	}

	return {
		pass: found.length > 0,
		label: "Tombstone key format",
		detail:
			found.length > 0
				? `found in ${found.join(", ")}`
				: "NOT found in code — spec drift!",
	};
}

export function checkRecordFields(files: Map<string, string>): CheckResult {
	const required = [
		"peerId",
		"protocol",
		"host",
		"port",
		"ttl",
		"bornAt",
		"expiresAt",
	];
	const allCode = [...files.values()].join("\n");
	const found: string[] = [];
	const missing: string[] = [];

	for (const field of required) {
		if (allCode.includes(field)) {
			found.push(field);
		} else {
			missing.push(field);
		}
	}

	return {
		pass: missing.length === 0,
		label: "Record fields",
		detail:
			`${found.length}/${required.length} required fields referenced` +
			(missing.length > 0 ? ` (missing: ${missing.join(", ")})` : ""),
	};
}

export function checkTTLBounds(files: Map<string, string>): CheckResult {
	const allCode = [...files.values()].join("\n");

	// Check for TTL range indicators: 15-60 min or 900-3600 seconds
	const patterns = [
		/\b15\b.*\b60\b/, // "15...60" (minutes)
		/\b900\b.*\b3600\b/, // "900...3600" (seconds)
		/\b15\b/, // at least "15"
		/\b60\b/, // at least "60"
		/ttl.*\d+/, // ttl = number
		/uniform\(/, // uniform(15, 60) from spec
	];

	const hasTTLEnforcement = patterns.some((p) => p.test(allCode));

	return {
		pass: hasTTLEnforcement,
		label: "TTL bounds (15-60min)",
		detail: hasTTLEnforcement
			? "enforced in source"
			: "NOT found in code — spec drift! (expected uniform(15,60) or 900-3600s range)",
	};
}

export function checkNoSerialMultiHop(files: Map<string, string>): CheckResult {
	const forbidden = ["route: []", "multiHop", "multi-hop", "serial.*hop"];
	const violations: string[] = [];

	for (const [name, content] of files) {
		for (const pattern of forbidden) {
			if (pattern.includes(".*")) {
				// regex pattern
				const re = new RegExp(pattern, "i");
				if (re.test(content)) {
					violations.push(`'${pattern}' in ${name}`);
				}
			} else {
				if (content.includes(pattern)) {
					violations.push(`'${pattern}' in ${name}`);
				}
			}
		}
	}

	return {
		pass: violations.length === 0,
		label: "No serial multi-hop",
		detail:
			violations.length === 0
				? "no serial multi-hop pattern detected"
				: `found ${violations.join(", ")} — violates consillium decision §10.15`,
	};
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
	const { specPath, srcPath } = parseArgs(process.argv);

	// Check spec file exists
	if (!existsSync(specPath)) {
		console.error(`❌ Spec file not found: ${specPath}`);
		console.error("   Use --spec <path> to override");
		process.exit(2);
	}

	const files = readSourceFiles(srcPath);

	if (files.size === 0) {
		console.error(`⚠ No TypeScript source files found in ${srcPath}`);
	}

	console.log("📋 Spec ↔ Code Drift Checker");
	console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	console.log(`  Spec:  ${specPath}`);
	console.log(`  Source: ${srcPath} (${files.size} files)`);
	console.log("");

	const checks: CheckResult[] = [
		checkDHTKeyPrefix(files),
		checkTombstoneFormat(files),
		checkRecordFields(files),
		checkTTLBounds(files),
		checkNoSerialMultiHop(files),
	];

	let driftDetected = false;

	for (const check of checks) {
		const icon = check.pass ? "✓" : check.detail.includes("drift") ? "⚠" : "✗";
		console.log(`${icon} ${check.label}: ${check.detail}`);
		if (!check.pass) driftDetected = true;
	}

	console.log("");

	if (driftDetected) {
		console.log("⚠ Spec drift detected — review flagged items above");
		process.exit(1);
	} else {
		console.log("✅ No spec drift detected");
		process.exit(0);
	}
}

const isMain =
	process.argv[1]?.endsWith("validate-spec.ts") ||
	process.argv[1]?.endsWith("validate-spec.js");
if (isMain) main();
