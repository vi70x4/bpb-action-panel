import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks – must appear BEFORE importing the module under test so that the
// module's top-level side-effects (express(), createServer(), new Server())
// execute against our mock objects.
// ---------------------------------------------------------------------------

// Shared mock instances — hoisted so vi.mock factories (which are hoisted to
// the top of the file) can write into them, and tests can read them.
const mockApp = vi.hoisted(() => ({
	get: vi.fn(),
	post: vi.fn(),
	use: vi.fn(),
	listen: vi.fn(),
}));
const mockServer = vi.hoisted(() => ({ listen: vi.fn() }));
const mockIo = vi.hoisted(() => ({ on: vi.fn(), emit: vi.fn() }));

vi.mock("express", () => {
	const factory = vi.fn(() => mockApp) as any;
	// express.json() / express.static() are properties on the default export
	factory.json = vi.fn();
	factory.static = vi.fn(() => vi.fn()); // static() returns middleware
	return { __esModule: true, default: factory };
});
vi.mock("http", () => ({ createServer: vi.fn(() => mockServer) }));
vi.mock("socket.io", () => ({ Server: vi.fn(() => mockIo) }));

// ---------------------------------------------------------------------------
// Import the module under test – triggers side-effects against the mocks.
// ---------------------------------------------------------------------------

import "./server.ts";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("server.ts", () => {
	// ---- App / server / IO setup -------------------------------------------

	it("creates Express app via the mocked factory", () => {
		// The express default export is the factory; it should have been called
		// once when server.ts ran `const app = express()`.
		// We verify by checking that the mock app's methods were registered.
		expect(mockApp.get).toHaveBeenCalled();
		expect(mockApp.post).toHaveBeenCalled();
		expect(mockApp.use).toHaveBeenCalled();
	});

	it("creates HTTP server with the mock app", () => {
		// createServer was called with the mockApp instance
		// We can't assert directly on createServer since it's not hoisted,
		// but we CAN verify the server.listen was called (below).
		expect(mockServer.listen).toHaveBeenCalled();
	});

	it("creates Socket.IO server", () => {
		expect(mockIo.on).toHaveBeenCalledWith("connection", expect.any(Function));
	});

	// ---- Route registration ------------------------------------------------

	it("registers GET /health route", () => {
		expect(mockApp.get).toHaveBeenCalledWith("/health", expect.any(Function));
	});

	it("registers GET /api/runs route", () => {
		expect(mockApp.get).toHaveBeenCalledWith("/api/runs", expect.any(Function));
	});

	it("registers POST /api/trigger-workflow route", () => {
		expect(mockApp.post).toHaveBeenCalledWith(
			"/api/trigger-workflow",
			expect.any(Function),
		);
	});

	it("registers static file serving", () => {
		// express.static() returns a middleware function; app.use is called with
		// the result. At least one `use` call should be a function (the static
		// middleware).
		const staticCalls = mockApp.use.mock.calls.filter(
			(call: any[]) => typeof call[0] === "function",
		);
		expect(staticCalls.length).toBeGreaterThanOrEqual(1);
	});

	it("registers error handler", () => {
		// Express error-handling middleware has signature (err, req, res, next)
		// i.e. 4 arguments.
		const errorHandlerCalls = mockApp.use.mock.calls.filter(
			(call: any[]) => typeof call[0] === "function" && call[0].length === 4,
		);
		expect(errorHandlerCalls.length).toBeGreaterThanOrEqual(1);
	});

	// ---- Listening --------------------------------------------------------

	it("starts listening on PORT", () => {
		// PORT = process.env.PORT || 3000 — defaults to 3000 (number)
		expect(mockServer.listen).toHaveBeenCalledWith(3000, expect.any(Function));
	});

	// ---- Socket.IO events -------------------------------------------------

	it("Socket.IO handles connection event", () => {
		expect(mockIo.on).toHaveBeenCalledWith("connection", expect.any(Function));
	});

	it("Socket.IO handles subscribe-actions", () => {
		// Find the connection handler, then verify it registers subscribe-actions.
		const connectionHandler = mockIo.on.mock.calls.find(
			(call: any[]) => call[0] === "connection",
		)?.[1];

		expect(connectionHandler).toBeDefined();

		// Fake socket that captures .on calls.
		const mockSocket = { on: vi.fn() };
		connectionHandler(mockSocket);

		expect(mockSocket.on).toHaveBeenCalledWith(
			"subscribe-actions",
			expect.any(Function),
		);
	});

	// ---- Route handler behaviour ------------------------------------------

	describe("GET /health handler", () => {
		it("returns JSON with status, message, timestamp, version", () => {
			const healthHandler = mockApp.get.mock.calls.find(
				(call: any[]) => call[0] === "/health",
			)?.[1];

			expect(healthHandler).toBeDefined();

			const mockReq = {};
			const mockRes = {
				json: vi.fn(),
				status: vi.fn().mockReturnThis(),
			};

			healthHandler(mockReq, mockRes);

			// server.ts calls res.status(200).json({...})
			expect(mockRes.status).toHaveBeenCalledWith(200);
			expect(mockRes.json).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "ok",
					message: expect.any(String),
					timestamp: expect.any(String),
					version: expect.any(String),
				}),
			);
		});
	});

	describe("GET /api/runs handler", () => {
		it("returns JSON with workflow runs array", () => {
			const runsHandler = mockApp.get.mock.calls.find(
				(call: any[]) => call[0] === "/api/runs",
			)?.[1];

			expect(runsHandler).toBeDefined();

			const mockReq = {};
			const mockRes = {
				json: vi.fn(),
				status: vi.fn().mockReturnThis(),
			};

			runsHandler(mockReq, mockRes);

			// server.ts calls res.json({ runs: [...] }) without an explicit status
			expect(mockRes.json).toHaveBeenCalledWith(
				expect.objectContaining({
					runs: expect.any(Array),
				}),
			);
		});
	});

	describe("POST /api/trigger-workflow handler", () => {
		it("reads workflow_id from body, emits via Socket.IO, returns success", () => {
			const triggerHandler = mockApp.post.mock.calls.find(
				(call: any[]) => call[0] === "/api/trigger-workflow",
			)?.[1];

			expect(triggerHandler).toBeDefined();

			const mockReq = { body: { workflow_id: "wf-123" } };
			const mockRes = {
				json: vi.fn(),
				status: vi.fn().mockReturnThis(),
			};

			triggerHandler(mockReq, mockRes);

			// server.ts emits "action-update" with type "workflow-triggered"
			expect(mockIo.emit).toHaveBeenCalledWith(
				"action-update",
				expect.objectContaining({
					type: "workflow-triggered",
					workflow_id: "wf-123",
				}),
			);
			expect(mockRes.json).toHaveBeenCalledWith(
				expect.objectContaining({ success: true }),
			);
		});
	});

	it("registers an error handler (4-arg middleware)", () => {
		// Find any use() call whose first argument is a function with 4 params
		const found = mockApp.use.mock.calls.some(
			(call: any[]) => typeof call[0] === "function" && call[0].length === 4,
		);
		expect(found).toBe(true);
	});
});
